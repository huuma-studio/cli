import type { Message, ToolResultContent } from "@huuma/ai/agent";
import { assertEquals, assertStringIncludes } from "@std/assert";
import type { Assistant } from "../chat.ts";
import type { CallbackDeps, ResponseLike } from "./callback.ts";
import type { ManagedConfig } from "./config.ts";
import { runManagedTurn } from "./runner.ts";

const RUN_ID = "00000000-0000-0000-0000-000000000001";
const TURN_ID = "00000000-0000-0000-0000-000000000002";
const CALLBACK_URL = "https://callback.example/managed-turn";

type RecordedCall = {
  headers: Record<string, string>;
  body: Uint8Array;
};

type CallbackHarness = {
  deps: CallbackDeps;
  calls: RecordedCall[];
  sleeps: number[];
};

function response(
  status: number,
  headers?: Record<string, string>,
): ResponseLike {
  return headers ? { status, headers: new Headers(headers) } : { status };
}

function callbackHarness(
  byKey: Record<string, (ResponseLike | Error)[]> = {},
): CallbackHarness {
  const queues = Object.fromEntries(
    Object.entries(byKey).map(([key, values]) => [key, [...values]]),
  ) as Record<string, (ResponseLike | Error)[]>;
  const calls: RecordedCall[] = [];
  const sleeps: number[] = [];
  let now = 0;
  let inFlight = false;

  return {
    calls,
    sleeps,
    deps: {
      now: () => new Date(now),
      random: () => 0,
      sleep: (ms) => {
        sleeps.push(ms);
        now += ms;
        return Promise.resolve();
      },
      fetch: async (_url, init) => {
        if (inFlight) throw new Error("callback delivery was reentrant");
        inFlight = true;
        try {
          await Promise.resolve();
          calls.push({ headers: { ...init.headers }, body: init.body });
          const key = init.headers["Idempotency-Key"]!;
          const next = queues[key]?.shift();
          if (next instanceof Error) throw next;
          return next ?? response(204);
        } finally {
          inFlight = false;
        }
      },
    },
  };
}

function body(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(call.body));
}

function events(harness: CallbackHarness): string[] {
  return harness.calls.map((call) => body(call).event as string);
}

function keys(harness: CallbackHarness): string[] {
  return harness.calls.map((call) => call.headers["Idempotency-Key"]!);
}

function model(text: string): Message {
  return { role: "model", contents: [{ text }], toolCalls: [] };
}

function finish(outcome: "completion" | "question"): Message {
  const content: ToolResultContent = {
    toolResult: {
      id: "finish-turn",
      name: "finish_turn",
      result: { output: { outcome } },
    },
  };
  return { role: "tool", contents: [content] };
}

function fakeAssistant(
  emissions: Message[],
  opts: { throwAfter?: Error } = {},
): { factory: () => Promise<Assistant>; runs: () => number } {
  let runCount = 0;
  return {
    runs: () => runCount,
    factory: () => {
      const run: Assistant["run"] = async (prompt, _history, options) => {
        runCount += 1;
        const all = [
          { role: "user", contents: prompt } as Message,
          ...emissions,
        ];
        for (const message of all) await options?.onMessage?.(message);
        if (opts.throwAfter) throw opts.throwAfter;
        return all;
      };
      return Promise.resolve({ run });
    },
  };
}

async function config(
  opts: { turnId?: string; deadlineMs?: number; missingHistory?: boolean } = {},
): Promise<{ value: ManagedConfig; cleanup: () => Promise<void> }> {
  const historyPath = opts.missingHistory
    ? "/tmp/huuma-missing-managed-history.json"
    : await Deno.makeTempFile({ suffix: ".json" });
  if (!opts.missingHistory) {
    await Deno.writeTextFile(
      historyPath,
      JSON.stringify([
        { role: "user", contents: "earlier" },
        model("earlier reply"),
        { role: "user", contents: "trigger" },
      ]),
    );
  }
  return {
    value: {
      callbackUrl: new URL(CALLBACK_URL),
      callbackSecret: "callback-secret",
      runId: RUN_ID,
      turnId: opts.turnId ?? TURN_ID,
      turnDeadline: new Date(opts.deadlineMs ?? 60_000),
      historyPath,
      cwd: ".",
      model: { provider: "anthropic", modelId: "claude-haiku-4-5" },
      host: undefined,
      tools: [],
      cliCommands: [],
      systemPrompt: undefined,
      searchEngine: undefined,
      skillsPath: undefined,
    },
    cleanup: async () => {
      if (!opts.missingHistory) await Deno.remove(historyPath);
    },
  };
}

async function withExitCode(
  fn: () => Promise<void>,
): Promise<number | undefined> {
  const prior = Deno.exitCode;
  Deno.exitCode = 0;
  try {
    await fn();
    return Deno.exitCode;
  } finally {
    Deno.exitCode = prior;
  }
}

Deno.test("managed integration completes with ordered callbacks and completion outcome", async () => {
  const h = callbackHarness();
  const agent = fakeAssistant([model("working"), finish("completion")]);
  const c = await config();
  try {
    const exitCode = await withExitCode(() =>
      runManagedTurn(c.value, {
        agentFactory: agent.factory,
        callbackDeps: h.deps,
      })
    );
    assertEquals(exitCode, 0);
    assertEquals(agent.runs(), 1);
    assertEquals(events(h), [
      "turn.running",
      "message.appended",
      "message.appended",
      "turn.finished",
    ]);
    assertEquals(keys(h), [
      `${TURN_ID}:turn.running`,
      `${TURN_ID}:message.appended:1`,
      `${TURN_ID}:message.appended:2`,
      `${TURN_ID}:terminal`,
    ]);
    assertEquals(h.calls.slice(1, 3).map((call) => body(call).turn_sequence), [
      1,
      2,
    ]);
    assertEquals(body(h.calls[3]!).outcome, "completion");
  } finally {
    await c.cleanup();
  }
});

Deno.test("managed integration reports question only after appended messages", async () => {
  const h = callbackHarness();
  const c = await config();
  try {
    const exitCode = await withExitCode(() =>
      runManagedTurn(c.value, {
        agentFactory:
          fakeAssistant([model("need details"), finish("question")]).factory,
        callbackDeps: h.deps,
      })
    );
    assertEquals(exitCode, 0);
    assertEquals(events(h), [
      "turn.running",
      "message.appended",
      "message.appended",
      "turn.finished",
    ]);
    assertEquals(body(h.calls.at(-1)!).outcome, "question");
  } finally {
    await c.cleanup();
  }
});

Deno.test("managed integration retries 429 Retry-After and 5xx with stable idempotency keys", async () => {
  const h = callbackHarness({
    [`${TURN_ID}:turn.running`]: [
      response(429, { "Retry-After": "1" }),
      response(204),
    ],
    [`${TURN_ID}:message.appended:1`]: [response(500), response(204)],
  });
  const c = await config();
  try {
    const exitCode = await withExitCode(() =>
      runManagedTurn(c.value, {
        agentFactory:
          fakeAssistant([model("retry me"), finish("completion")]).factory,
        callbackDeps: h.deps,
      })
    );
    assertEquals(exitCode, 0);
    assertEquals(h.sleeps, [1000, 125]);
    assertEquals(keys(h).slice(0, 2), [
      `${TURN_ID}:turn.running`,
      `${TURN_ID}:turn.running`,
    ]);
    assertEquals(keys(h).slice(2, 4), [
      `${TURN_ID}:message.appended:1`,
      `${TURN_ID}:message.appended:1`,
    ]);
    assertEquals(h.calls[0]!.body, h.calls[1]!.body);
    assertEquals(h.calls[2]!.body, h.calls[3]!.body);
  } finally {
    await c.cleanup();
  }
});

for (const status of [401, 403]) {
  Deno.test(`managed integration stops after turn.running ${status} without turn.failed`, async () => {
    const h = callbackHarness({
      [`${TURN_ID}:turn.running`]: [response(status)],
    });
    const agent = fakeAssistant([finish("completion")]);
    const c = await config();
    try {
      const exitCode = await withExitCode(() =>
        runManagedTurn(c.value, {
          agentFactory: agent.factory,
          callbackDeps: h.deps,
        })
      );
      assertEquals(exitCode, 1);
      assertEquals(events(h), ["turn.running"]);
      assertEquals(agent.runs(), 0);
    } finally {
      await c.cleanup();
    }
  });
}

for (const status of [202, 409, 413, 422]) {
  Deno.test(`managed integration turns fatal callback ${status} into one failure terminal`, async () => {
    const h = callbackHarness({
      [`${TURN_ID}:turn.running`]: [response(status)],
    });
    const c = await config();
    try {
      const exitCode = await withExitCode(() =>
        runManagedTurn(c.value, {
          agentFactory: fakeAssistant([finish("completion")]).factory,
          callbackDeps: h.deps,
        })
      );
      assertEquals(exitCode, 1);
      assertEquals(events(h), ["turn.running", "turn.failed"]);
      assertEquals(
        keys(h).filter((key) => key.endsWith(":terminal")).length,
        1,
      );
    } finally {
      await c.cleanup();
    }
  });
}

Deno.test("managed integration reports setup and input initialization failures", async () => {
  const setup = callbackHarness();
  const setupConfig = await config();
  const input = callbackHarness();
  const inputConfig = await config({ missingHistory: true });
  try {
    const setupExit = await withExitCode(() =>
      runManagedTurn(setupConfig.value, {
        agentFactory: async () =>
          await Promise.reject(new Error("setup failed")),
        callbackDeps: setup.deps,
      })
    );
    const inputExit = await withExitCode(() =>
      runManagedTurn(inputConfig.value, {
        agentFactory: fakeAssistant([finish("completion")]).factory,
        callbackDeps: input.deps,
      })
    );
    assertEquals(setupExit, 1);
    assertEquals(events(setup), ["turn.failed"]);
    assertStringIncludes(body(setup.calls[0]!).error as string, "setup failed");
    assertEquals(inputExit, 1);
    assertEquals(events(input), ["turn.failed"]);
  } finally {
    await setupConfig.cleanup();
    await inputConfig.cleanup();
  }
});

Deno.test("managed integration reports agent failure after running and retains acknowledged prefix", async () => {
  const agentFailure = callbackHarness();
  const prefixFailure = callbackHarness({
    [`${TURN_ID}:message.appended:2`]: [response(413)],
  });
  const c1 = await config();
  const c2 = await config();
  try {
    const agentExit = await withExitCode(() =>
      runManagedTurn(c1.value, {
        agentFactory: fakeAssistant([model("partial")], {
          throwAfter: new Error("provider failed"),
        }).factory,
        callbackDeps: agentFailure.deps,
      })
    );
    const prefixExit = await withExitCode(() =>
      runManagedTurn(c2.value, {
        agentFactory: fakeAssistant([
          model("acknowledged"),
          model("rejected"),
          finish("completion"),
        ]).factory,
        callbackDeps: prefixFailure.deps,
      })
    );
    assertEquals(agentExit, 1);
    assertEquals(events(agentFailure), [
      "turn.running",
      "message.appended",
      "turn.failed",
    ]);
    assertEquals(prefixExit, 1);
    assertEquals(events(prefixFailure), [
      "turn.running",
      "message.appended",
      "message.appended",
      "turn.failed",
    ]);
    assertEquals(
      prefixFailure.calls.slice(1, 3).map((call) => body(call).turn_sequence),
      [1, 2],
    );
  } finally {
    await c1.cleanup();
    await c2.cleanup();
  }
});

Deno.test("managed integration reserves deadline for failure and retries terminal until deadline", async () => {
  const reserve = callbackHarness();
  const terminalRetry = callbackHarness({
    [`${TURN_ID}:terminal`]: [response(500), response(204)],
  });
  const c1 = await config({ deadlineMs: 10_000 });
  const c2 = await config({ deadlineMs: 20_000 });
  try {
    const reserveExit = await withExitCode(() =>
      runManagedTurn(c1.value, {
        agentFactory: fakeAssistant([finish("completion")]).factory,
        callbackDeps: reserve.deps,
      })
    );
    const terminalExit = await withExitCode(() =>
      runManagedTurn(c2.value, {
        agentFactory:
          fakeAssistant([], { throwAfter: new Error("agent failed") }).factory,
        callbackDeps: terminalRetry.deps,
      })
    );
    assertEquals(reserveExit, 1);
    assertEquals(events(reserve), ["turn.failed"]);
    assertEquals(terminalExit, 1);
    assertEquals(events(terminalRetry), [
      "turn.running",
      "turn.failed",
      "turn.failed",
    ]);
    assertEquals(terminalRetry.sleeps, [125]);
  } finally {
    await c1.cleanup();
    await c2.cleanup();
  }
});

Deno.test("managed integration assigns a different turn id to a separate execution", async () => {
  const secondTurn = "00000000-0000-0000-0000-000000000003";
  const first = callbackHarness();
  const second = callbackHarness();
  const c1 = await config();
  const c2 = await config({ turnId: secondTurn });
  try {
    await withExitCode(() =>
      runManagedTurn(c1.value, {
        agentFactory: fakeAssistant([finish("completion")]).factory,
        callbackDeps: first.deps,
      })
    );
    await withExitCode(() =>
      runManagedTurn(c2.value, {
        agentFactory: fakeAssistant([finish("completion")]).factory,
        callbackDeps: second.deps,
      })
    );
    assertEquals(
      keys(first).every((key) => key.startsWith(`${TURN_ID}:`)),
      true,
    );
    assertEquals(
      keys(second).every((key) => key.startsWith(`${secondTurn}:`)),
      true,
    );
    assertEquals(second.calls.map((call) => body(call).turn_id), [
      secondTurn,
      secondTurn,
      secondTurn,
    ]);
  } finally {
    await c1.cleanup();
    await c2.cleanup();
  }
});
