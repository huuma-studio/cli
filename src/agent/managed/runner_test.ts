/**
 * Tests for the managed-turn runner (T5).
 *
 * The runner is exercised end-to-end with a fake `Assistant` factory and a
 * real `CallbackReporter` backed by injectable `CallbackDeps`. The fake
 * Agent emits a configurable sequence of messages (the first being the
 * triggering user message, matching the real `@huuma/ai` behavior) and
 * awaits each `onMessage` call so backpressure is observable. The fake
 * fetch returns queued responses keyed by `Idempotency-Key` (default
 * `204`), records every call, and asserts it is never reentrant.
 */
import type {
  FileContent,
  Message,
  TextContent,
  ToolResultContent,
} from "@huuma/ai/agent";
import { assertEquals, assertNotEquals } from "@std/assert";
import type { CallbackDeps, ResponseLike } from "./callback.ts";
import type { ManagedConfig } from "./config.ts";
import type { Assistant } from "../chat.ts";
import type { SetupResult } from "../setup.ts";
import { type ManagedTurnDeps, runManagedTurn } from "./runner.ts";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/** A recorded fetch call: URL + init. */
interface RecordedFetch {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
  timeoutMs: number;
}

/** Options for {@link makeCallbackDeps}. */
interface CallbackDepsOptions {
  /** Map idempotency-key → queue of responses (consumed in order per call
   * with that key). Missing or empty queue → `defaultResponse`. */
  byKey?: Record<string, (ResponseLike | Error)[]>;
  /** Default response when a key has no queued response. Defaults to 204. */
  defaultResponse?: ResponseLike;
  /** Initial clock value (ms). Defaults to 0. */
  initialClockMs?: number;
  /** Turn deadline as ms-since-clock-origin. Defaults to 60_000. */
  turnDeadlineMs?: number;
  /** Random source for backoff jitter. Defaults to constant 0. */
  random?: () => number;
}

/** Builds injectable `CallbackDeps` with a recording, non-reentrant fake
 * fetch. The clock starts at `initialClockMs` and advances by the sleep
 * duration on each `sleep` call. The fetch yields one microtask before
 * recording so true reentrancy would be observed. */
function makeCallbackDeps(opts: CallbackDepsOptions = {}) {
  const byKey: Record<string, (ResponseLike | Error)[]> = {};
  for (const k of Object.keys(opts.byKey ?? {})) {
    byKey[k] = [...(opts.byKey![k]!)];
  }
  const defaultResponse = opts.defaultResponse ?? { status: 204 };
  let clockMs = opts.initialClockMs ?? 0;
  const randomFn = opts.random ?? (() => 0);
  const sleepCalls: number[] = [];
  const fetchCalls: RecordedFetch[] = [];
  let inFlight = 0;

  const deps: CallbackDeps = {
    now: () => new Date(clockMs),
    sleep: (ms: number) => {
      sleepCalls.push(ms);
      clockMs += ms;
      return Promise.resolve();
    },
    random: randomFn,
    fetch: (url: string, init) => {
      if (inFlight > 0) {
        throw new Error(
          "test fetch called reentrantly — runner violated one-in-flight",
        );
      }
      // Returned promise resolves asynchronously so a reentrant caller
      // would observe `inFlight > 0`.
      return (async () => {
        inFlight++;
        try {
          await Promise.resolve();
          fetchCalls.push({
            url,
            headers: { ...init.headers },
            body: init.body,
            timeoutMs: init.timeoutMs,
          });
          const key = init.headers["Idempotency-Key"] ?? "";
          const q = byKey[key];
          const next = q?.shift();
          if (next === undefined) return defaultResponse;
          if (next instanceof Error) throw next;
          return next;
        } finally {
          inFlight--;
        }
      })();
    },
  };

  return {
    deps,
    fetchCalls,
    sleepCalls,
    clock: () => clockMs,
    turnDeadlineMs: opts.turnDeadlineMs ?? 60_000,
  };
}

/** Decodes a recorded fetch body as JSON. */
function decodeBody(body: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(body));
}

/** A response with optional headers. */
function response(
  status: number,
  headers?: Record<string, string>,
): ResponseLike {
  if (headers) return { status, headers: new Headers(headers) };
  return { status };
}

// ---------------------------------------------------------------------------
// Fake Agent
// ---------------------------------------------------------------------------

/** Options for {@link makeFakeAgentFactory}. */
interface FakeAgentOptions {
  /** Messages emitted after the first (which is always
   * `{ role: "user", contents: prompt }` — the triggering user message,
   * matching the real `@huuma/ai` behavior). The last of these typically
   * carries a successful `finish_turn` tool result. */
  extraEmissions?: Message[];
  /** Overrides the first emission. Used to test first-emission mismatch
   * (protocol failure). */
  firstMessageOverride?: Message;
  /** If set, the fake throws `throwError` before emitting the message at
   * this index (0 = before the first emission). */
  throwBeforeIndex?: number;
  /** Error to throw at `throwBeforeIndex` or when `throwAfterAll` is set. */
  throwError?: Error;
  /** If true, throws `throwError` after emitting all messages. */
  throwAfterAll?: boolean;
  /** If set, the first N `run()` invocations throw `throwError` before
   * emitting anything — the transient model-failure shape the runner's
   * retry loop (ADR 0010) recovers from. */
  failFirstRuns?: number;
}

/** Builds a fake `agentFactory` that returns an `Assistant` whose `run`
 * emits the configured message sequence, awaiting each `onMessage` call
 * (so backpressure is observable), and records the prompt and history it
 * received. */
function makeFakeAgentFactory(opts: FakeAgentOptions = {}) {
  let receivedConfig: ManagedConfig | undefined;
  let receivedPrompt: string | (TextContent | FileContent)[] | undefined;
  let receivedHistory: Message[] | undefined;
  let runCallCount = 0;

  // `async` matches the `ManagedTurnDeps.agentFactory` signature
  // `(config) => Promise<SetupResult>`; the body is synchronous today.
  // deno-lint-ignore require-await
  const factory = async (config: ManagedConfig): Promise<SetupResult> => {
    receivedConfig = config;
    const run: Assistant["run"] = async (prompt, history, options) => {
      runCallCount += 1;
      receivedPrompt = prompt;
      receivedHistory = history;
      if (
        opts.failFirstRuns !== undefined && runCallCount <= opts.failFirstRuns
      ) {
        throw opts.throwError ?? new Error("fake agent error");
      }
      const first: Message = opts.firstMessageOverride ??
        {
          role: "user",
          contents: prompt as string | (TextContent | FileContent)[],
        };
      const emissions = [first, ...(opts.extraEmissions ?? [])];
      const messages: Message[] = [];
      for (let i = 0; i < emissions.length; i++) {
        if (
          opts.throwBeforeIndex !== undefined && opts.throwBeforeIndex === i
        ) {
          throw opts.throwError ?? new Error("fake agent error");
        }
        if (options?.onMessage) {
          await options.onMessage(emissions[i]!);
        }
        messages.push(emissions[i]!);
      }
      if (opts.throwAfterAll) {
        throw opts.throwError ?? new Error("fake agent error");
      }
      return messages;
    };
    return { assistant: { run }, mcpConnections: [] };
  };

  return {
    factory,
    received: () => ({
      config: receivedConfig,
      prompt: receivedPrompt,
      history: receivedHistory,
    }),
    runCallCount: () => runCallCount,
  };
}

/** Builds a `tool` message containing a successful `finish_turn` result
 * with the given outcome. */
function finishTurnMessage(outcome: "question" | "completion"): Message {
  const content: ToolResultContent = {
    toolResult: {
      id: "finish-turn-1",
      name: "finish_turn",
      result: {
        output: { outcome, message: "done" },
      },
    },
  };
  return { role: "tool", contents: [content] };
}

/** A model text message. */
function modelMessage(text: string): Message {
  return { role: "model", contents: [{ text }], toolCalls: [] };
}

// ---------------------------------------------------------------------------
// Config + history helpers
// ---------------------------------------------------------------------------

const RUN_ID = "00000000-0000-0000-0000-000000000001";
const TURN_ID = "00000000-0000-0000-0000-000000000002";
const CALLBACK_URL = "https://callback.example/cb";
const CALLBACK_SECRET = "turn-secret";

/** Default history for tests: a small conversation ending with a user
 * message whose contents become the `agent.run` prompt. */
function defaultHistory(): Message[] {
  return [
    { role: "user", contents: "previous user message" },
    {
      role: "model",
      contents: [{ text: "previous model response" }],
      toolCalls: [],
    },
    { role: "user", contents: "triggering user message" },
  ];
}

interface MakeConfigOptions {
  historyMessages?: Message[];
  historyPath?: string;
  turnDeadlineMs?: number;
  callbackUrl?: URL;
  runId?: string;
  turnId?: string;
  callbackSecret?: string;
  /** Additional model-call attempts (ADR 0010). Existing tests default to 0,
   * pinning today's no-retry paths; retry tests pass an explicit value. */
  retries?: number;
}

/** Builds a valid {@link ManagedConfig}. When `historyPath` is unset and
 * `historyMessages` is provided (or the default), writes a temp JSON file
 * and returns a `cleanup` to remove it. Pass `historyPath` to point at a
 * pre-existing (or non-existent) path without writing. */
async function makeConfig(
  opts: MakeConfigOptions = {},
): Promise<{ config: ManagedConfig; cleanup: () => Promise<void> }> {
  let historyPath = opts.historyPath;
  let ownTemp = false;
  if (historyPath === undefined) {
    const messages = opts.historyMessages ?? defaultHistory();
    const tmp = await Deno.makeTempFile({ suffix: ".json" });
    await Deno.writeTextFile(tmp, JSON.stringify(messages));
    historyPath = tmp;
    ownTemp = true;
  }
  const config: ManagedConfig = {
    callbackUrl: opts.callbackUrl ?? new URL(CALLBACK_URL),
    runId: opts.runId ?? RUN_ID,
    turnId: opts.turnId ?? TURN_ID,
    turnDeadline: new Date(opts.turnDeadlineMs ?? 60_000),
    historyPath,
    cwd: ".",
    model: { provider: "anthropic", modelId: "claude-haiku-4-5" },
    host: undefined,
    tools: [],
    cliCommands: [],
    systemPrompt: undefined,
    searchEngine: undefined,
    skillsPath: undefined,
    specsPermissions: [],
    specsApiUrl: undefined,
    mcpConfig: undefined,
    mcpServers: [],
    // Existing tests default to 0, pinning today's no-retry paths; retry
    // tests pass an explicit value (ADR 0010).
    retries: opts.retries ?? 0,
    callbackSecret: opts.callbackSecret ?? CALLBACK_SECRET,
  };
  return {
    config,
    cleanup: async () => {
      if (ownTemp) {
        try {
          await Deno.remove(historyPath!);
        } catch {
          // ignore — temp file already gone
        }
      }
    },
  };
}

/** Saves `Deno.exitCode`, resets it to 0, runs `fn`, and restores the prior
 * value in `finally`. Tests assert the post-run exit code without leaking
 * state to siblings. Accepts a sync or async body. */
async function withExitCode<T>(fn: () => T | Promise<T>): Promise<T> {
  const prior = Deno.exitCode;
  Deno.exitCode = 0;
  try {
    return await fn();
  } finally {
    Deno.exitCode = prior;
  }
}

// ---------------------------------------------------------------------------
// Shared assertions
// ---------------------------------------------------------------------------

/** Event kinds recorded from request bodies. */
function eventKinds(calls: RecordedFetch[]): string[] {
  return calls.map((c) => (decodeBody(c.body) as { event: string }).event);
}

/** Idempotency keys in order. */
function idempotencyKeys(calls: RecordedFetch[]): string[] {
  return calls.map((c) => c.headers["Idempotency-Key"] ?? "");
}

/** Count of terminal idempotency keys (`<turn-id>:terminal`). */
function terminalKeyCount(calls: RecordedFetch[]): number {
  return idempotencyKeys(calls).filter((k) => k.endsWith(":terminal")).length;
}

// ---------------------------------------------------------------------------
// 1. Happy-path completed Turn
// ---------------------------------------------------------------------------

Deno.test("happy path: turn.running → ordered message.appended → turn.finished(completion), exit 0", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps();
    const agent = makeFakeAgentFactory({
      extraEmissions: [
        modelMessage("Working on it."),
        modelMessage("Calling finish_turn."),
        finishTurnMessage("completion"),
      ],
    });
    const { config, cleanup } = await makeConfig();
    try {
      const deps: ManagedTurnDeps = {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      };
      await runManagedTurn(config, deps);

      assertEquals(Deno.exitCode, 0);
      assertEquals(agent.runCallCount(), 1);
      // turn.running + 3 message.appended + turn.finished
      assertEquals(cb.fetchCalls.length, 5);

      const events = eventKinds(cb.fetchCalls);
      assertEquals(events, [
        "turn.running",
        "message.appended",
        "message.appended",
        "message.appended",
        "turn.finished",
      ]);

      // turn_sequence starts at 1 and increments.
      const seqs = cb.fetchCalls
        .map((c) =>
          (decodeBody(c.body) as { turn_sequence?: number }).turn_sequence
        )
        .filter((v) => v !== undefined);
      assertEquals(seqs, [1, 2, 3]);

      // turn.finished carries outcome === "completion".
      const finished = decodeBody(cb.fetchCalls.at(-1)!.body) as {
        event: string;
        outcome: string;
      };
      assertEquals(finished.event, "turn.finished");
      assertEquals(finished.outcome, "completion");

      // Headers on every request.
      for (const call of cb.fetchCalls) {
        assertEquals(call.url, CALLBACK_URL);
        assertEquals(
          call.headers["Authorization"],
          `Bearer ${CALLBACK_SECRET}`,
        );
        assertEquals(call.headers["Content-Type"], "application/json");
        assertEquals(typeof call.headers["Idempotency-Key"], "string");
      }

      // Idempotency keys follow the normative scheme.
      const keys = idempotencyKeys(cb.fetchCalls);
      assertEquals(keys, [
        `${TURN_ID}:turn.running`,
        `${TURN_ID}:message.appended:1`,
        `${TURN_ID}:message.appended:2`,
        `${TURN_ID}:message.appended:3`,
        `${TURN_ID}:terminal`,
      ]);

      // Envelope fields on every request.
      for (const call of cb.fetchCalls) {
        const body = decodeBody(call.body) as {
          run_id: string;
          turn_id: string;
        };
        assertEquals(body.run_id, RUN_ID);
        assertEquals(body.turn_id, TURN_ID);
      }
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Question outcome
// ---------------------------------------------------------------------------

Deno.test("happy path: question outcome is propagated", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps();
    const agent = makeFakeAgentFactory({
      extraEmissions: [
        modelMessage("Need more info."),
        finishTurnMessage("question"),
      ],
    });
    const { config, cleanup } = await makeConfig();
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 0);
      const finished = decodeBody(cb.fetchCalls.at(-1)!.body) as {
        event: string;
        outcome: string;
      };
      assertEquals(finished.event, "turn.finished");
      assertEquals(finished.outcome, "question");
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. First emitted user message is suppressed
// ---------------------------------------------------------------------------

Deno.test("first emission (triggering user message) is suppressed — first message.appended has turn_sequence 1", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps();
    const agent = makeFakeAgentFactory({
      extraEmissions: [modelMessage("hi"), finishTurnMessage("completion")],
    });
    const { config, cleanup } = await makeConfig();
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 0);

      // turn.running + 2 message.appended (model + finish_turn) + turn.finished.
      // The triggering user message is NOT delivered as a message.appended.
      assertEquals(eventKinds(cb.fetchCalls), [
        "turn.running",
        "message.appended",
        "message.appended",
        "turn.finished",
      ]);

      // The first message.appended body has turn_sequence: 1 (not 0).
      const firstMsg = decodeBody(
        cb.fetchCalls.find((c) =>
          (decodeBody(c.body) as { event: string }).event === "message.appended"
        )!.body,
      ) as { turn_sequence: number; message: Message };
      assertEquals(firstMsg.turn_sequence, 1);

      // The fake agent received the split prompt + history.
      const { prompt, history } = agent.received();
      assertEquals(prompt, "triggering user message");
      assertEquals(history!.length, 2);
      assertEquals((history![0] as Message).role, "user");
      assertEquals((history![1] as Message).role, "model");
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. First emission mismatch → protocol failure → turn.failed
// ---------------------------------------------------------------------------

Deno.test("first emission role mismatch → protocol failure → turn.failed, exit 1", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps();
    const agent = makeFakeAgentFactory({
      firstMessageOverride: modelMessage("wrong role"),
      extraEmissions: [finishTurnMessage("completion")],
    });
    const { config, cleanup } = await makeConfig();
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 1);

      // No turn.running-or-after delivery happened via the agent loop: the
      // first onMessage threw immediately, so the agent's emissions were
      // never delivered. Expected fetch sequence: turn.running + turn.failed.
      assertEquals(eventKinds(cb.fetchCalls), ["turn.running", "turn.failed"]);
      assertEquals(terminalKeyCount(cb.fetchCalls), 1);

      const failed = decodeBody(cb.fetchCalls.at(-1)!.body) as {
        event: string;
        error: string;
      };
      assertEquals(failed.event, "turn.failed");
      // Sanitized error mentions the protocol failure.
      assertNotEquals(failed.error.indexOf("protocol failure"), -1);
    } finally {
      await cleanup();
    }
  });
});

Deno.test("first emission contents mismatch → protocol failure → turn.failed", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps();
    // First emission has role user but contents differ from the prompt.
    const agent = makeFakeAgentFactory({
      firstMessageOverride: { role: "user", contents: "different contents" },
      extraEmissions: [finishTurnMessage("completion")],
    });
    const { config, cleanup } = await makeConfig();
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 1);
      assertEquals(eventKinds(cb.fetchCalls), ["turn.running", "turn.failed"]);
      const failed = decodeBody(cb.fetchCalls.at(-1)!.body) as {
        error: string;
      };
      assertNotEquals(failed.error.indexOf("protocol failure"), -1);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. turn.running 401 → auth-stop, no turn.failed
// ---------------------------------------------------------------------------

Deno.test("turn.running 401 → auth-stop → exit 1, no terminal event", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps({
      byKey: { [`${TURN_ID}:turn.running`]: [response(401)] },
    });
    const agent = makeFakeAgentFactory({
      extraEmissions: [finishTurnMessage("completion")],
    });
    const { config, cleanup } = await makeConfig();
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 1);
      // Only the rejected turn.running request was made.
      assertEquals(cb.fetchCalls.length, 1);
      assertEquals(eventKinds(cb.fetchCalls), ["turn.running"]);
      assertEquals(terminalKeyCount(cb.fetchCalls), 0);
      // Agent was never run.
      assertEquals(agent.runCallCount(), 0);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. turn.running 403 → auth-stop, no turn.failed
// ---------------------------------------------------------------------------

Deno.test("turn.running 403 → auth-stop → exit 1, no terminal event", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps({
      byKey: { [`${TURN_ID}:turn.running`]: [response(403)] },
    });
    const agent = makeFakeAgentFactory({
      extraEmissions: [finishTurnMessage("completion")],
    });
    const { config, cleanup } = await makeConfig();
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 1);
      assertEquals(eventKinds(cb.fetchCalls), ["turn.running"]);
      assertEquals(terminalKeyCount(cb.fetchCalls), 0);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. turn.running 409 → conflict → turn.failed
// ---------------------------------------------------------------------------

Deno.test("turn.running 409 → conflict → turn.failed attempted, exit 1", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps({
      byKey: { [`${TURN_ID}:turn.running`]: [response(409)] },
    });
    const agent = makeFakeAgentFactory({
      extraEmissions: [finishTurnMessage("completion")],
    });
    const { config, cleanup } = await makeConfig();
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 1);
      assertEquals(eventKinds(cb.fetchCalls), ["turn.running", "turn.failed"]);
      assertEquals(terminalKeyCount(cb.fetchCalls), 1);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 8. turn.running 500 then 204 → retry succeeds → agent runs
// ---------------------------------------------------------------------------

Deno.test("turn.running 500 then 204 → transient retry succeeds → agent runs to completion", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps({
      byKey: {
        [`${TURN_ID}:turn.running`]: [response(500), response(204)],
      },
    });
    const agent = makeFakeAgentFactory({
      extraEmissions: [modelMessage("ok"), finishTurnMessage("completion")],
    });
    const { config, cleanup } = await makeConfig();
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 0);
      // turn.running took 2 attempts; the rest took 1 each.
      assertEquals(eventKinds(cb.fetchCalls), [
        "turn.running",
        "turn.running",
        "message.appended",
        "message.appended",
        "turn.finished",
      ]);
      // One sleep happened (between the 500 and the retry).
      assertEquals(cb.sleepCalls.length, 1);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 9. message.appended 401 mid-loop → auth-stop, no turn.failed
// ---------------------------------------------------------------------------

Deno.test("message.appended 401 mid-loop → auth-stop → exit 1, no turn.failed", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps({
      byKey: {
        [`${TURN_ID}:message.appended:1`]: [response(401)],
      },
    });
    const agent = makeFakeAgentFactory({
      extraEmissions: [
        modelMessage("first"), // seq 1 → 401
        modelMessage("second"), // seq 2 — never emitted
        finishTurnMessage("completion"),
      ],
    });
    const { config, cleanup } = await makeConfig();
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 1);
      // turn.running + the rejected message.appended:1 (no terminal).
      assertEquals(eventKinds(cb.fetchCalls), [
        "turn.running",
        "message.appended",
      ]);
      assertEquals(terminalKeyCount(cb.fetchCalls), 0);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 10. message.appended 409 mid-loop → conflict → turn.failed (prefix preserved)
// ---------------------------------------------------------------------------

Deno.test("message.appended 409 mid-loop → conflict → turn.failed, acknowledged prefix preserved", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps({
      byKey: {
        [`${TURN_ID}:message.appended:2`]: [response(409)],
      },
    });
    const agent = makeFakeAgentFactory({
      extraEmissions: [
        modelMessage("first"), // seq 1 → 204 (acknowledged)
        modelMessage("second"), // seq 2 → 409 (aborts the loop)
        finishTurnMessage("completion"), // never emitted
      ],
    });
    const { config, cleanup } = await makeConfig();
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 1);
      // turn.running + 2 message.appended (seq 1 ack'd, seq 2 rejected) + turn.failed.
      assertEquals(eventKinds(cb.fetchCalls), [
        "turn.running",
        "message.appended",
        "message.appended",
        "turn.failed",
      ]);
      assertEquals(terminalKeyCount(cb.fetchCalls), 1);
      // The acknowledged prefix (seq 1) was delivered before the failure.
      const seqs = cb.fetchCalls
        .map((c) =>
          (decodeBody(c.body) as { turn_sequence?: number }).turn_sequence
        )
        .filter((v) => v !== undefined);
      assertEquals(seqs, [1, 2]);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 11. message.appended 500 then 204 → retry → loop continues
// ---------------------------------------------------------------------------

Deno.test("message.appended 500 then 204 → transient retry → loop continues to finish", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps({
      byKey: {
        [`${TURN_ID}:message.appended:1`]: [response(500), response(204)],
      },
    });
    const agent = makeFakeAgentFactory({
      extraEmissions: [
        modelMessage("first"), // seq 1 → 500 then 204
        finishTurnMessage("completion"),
      ],
    });
    const { config, cleanup } = await makeConfig();
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 0);
      assertEquals(eventKinds(cb.fetchCalls), [
        "turn.running",
        "message.appended",
        "message.appended",
        "message.appended",
        "turn.finished",
      ]);
      // The retried message.appended:1 appears twice in the call log.
      const seqs = cb.fetchCalls
        .map((c) =>
          (decodeBody(c.body) as { turn_sequence?: number }).turn_sequence
        )
        .filter((v) => v !== undefined);
      assertEquals(seqs, [1, 1, 2]);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 12. Agent loop throws a non-callback error → turn.failed
// ---------------------------------------------------------------------------

Deno.test("agent.run throws non-callback error → turn.failed with sanitized error, exit 1", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps();
    const agent = makeFakeAgentFactory({
      extraEmissions: [modelMessage("partial")],
      throwAfterAll: true,
      throwError: new Error("provider exploded"),
    });
    const { config, cleanup } = await makeConfig();
    const errors: string[] = [];
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
        logError: (message) => errors.push(message),
      });
      assertEquals(Deno.exitCode, 1);
      assertEquals(eventKinds(cb.fetchCalls), [
        "turn.running",
        "message.appended",
        "turn.failed",
      ]);
      const failed = decodeBody(cb.fetchCalls.at(-1)!.body) as {
        error: string;
      };
      assertNotEquals(failed.error.indexOf("provider exploded"), -1);
      assertEquals(errors, ["[managed:agent.run] provider exploded"]);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 13. No finish_turn: text-only model message → implicit "question";
//     non-model last message → protocol failure → turn.failed
// ---------------------------------------------------------------------------

Deno.test("agent.run returns text-only model message without finish_turn → implicit question, exit 0", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps();
    const agent = makeFakeAgentFactory({
      extraEmissions: [modelMessage("here is my answer to the user")],
    });
    const { config, cleanup } = await makeConfig();
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 0);
      assertEquals(eventKinds(cb.fetchCalls), [
        "turn.running",
        "message.appended",
        "turn.finished",
      ]);
      const finished = decodeBody(cb.fetchCalls.at(-1)!.body) as {
        outcome: string;
      };
      assertEquals(finished.outcome, "question");
    } finally {
      await cleanup();
    }
  });
});

Deno.test("agent.run returns non-model last message without finish_turn → protocol failure → turn.failed, exit 1", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps();
    // A tool message that is NOT finish_turn as the last emission — the
    // loop ended on a non-model message with no finish_turn, which is still
    // a protocol failure (no text-only model fallback applies).
    const toolMessage: Message = {
      role: "tool",
      contents: [{
        toolResult: {
          id: "other-tool",
          name: "grep",
          result: { output: "results" },
        },
      }],
    };
    const agent = makeFakeAgentFactory({
      extraEmissions: [toolMessage],
    });
    const { config, cleanup } = await makeConfig();
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 1);
      assertEquals(eventKinds(cb.fetchCalls), [
        "turn.running",
        "message.appended",
        "turn.failed",
      ]);
      const failed = decodeBody(cb.fetchCalls.at(-1)!.body) as {
        error: string;
      };
      assertNotEquals(failed.error.indexOf("finish_turn"), -1);
    } finally {
      await cleanup();
    }
  });
});

Deno.test("text-only model message followed by non-finish tool message → protocol failure (not implicit question)", async () => {
  // Regression: the fallback must only apply when the LAST message is a
  // text-only model message. A run ending on a tool message (without
  // finish_turn) is abnormal even if an earlier model message was text-only —
  // walking backwards to find a model message would incorrectly report an
  // implicit question here.
  await withExitCode(async () => {
    const cb = makeCallbackDeps();
    const toolMessage: Message = {
      role: "tool",
      contents: [{
        toolResult: {
          id: "other-tool",
          name: "grep",
          result: { output: "results" },
        },
      }],
    };
    const agent = makeFakeAgentFactory({
      extraEmissions: [modelMessage("partial answer"), toolMessage],
    });
    const { config, cleanup } = await makeConfig();
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 1);
      assertEquals(eventKinds(cb.fetchCalls), [
        "turn.running",
        "message.appended",
        "message.appended",
        "turn.failed",
      ]);
      const failed = decodeBody(cb.fetchCalls.at(-1)!.body) as {
        error: string;
      };
      assertNotEquals(failed.error.indexOf("finish_turn"), -1);
    } finally {
      await cleanup();
    }
  });
});

Deno.test("failed finish_turn followed by text-only model message → protocol failure (not implicit question)", async () => {
  // Regression: when finish_turn is called but errors (or produces a
  // malformed output), decodeFinishTurnOutcome returns "failed" rather than
  // undefined. The implicit-question fallback must NOT apply — the model
  // explicitly attempted to end the turn, so guessing "question" from a
  // later text-only model message would mask the failed call.
  await withExitCode(async () => {
    const cb = makeCallbackDeps();
    const failedFinishTurn: Message = {
      role: "tool",
      contents: [{
        toolResult: {
          id: "finish-turn-1",
          name: "finish_turn",
          result: { error: "invalid outcome value" },
        },
      }],
    };
    const agent = makeFakeAgentFactory({
      extraEmissions: [failedFinishTurn, modelMessage("here is my answer")],
    });
    const { config, cleanup } = await makeConfig();
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 1);
      assertEquals(eventKinds(cb.fetchCalls), [
        "turn.running",
        "message.appended",
        "message.appended",
        "turn.failed",
      ]);
      const failed = decodeBody(cb.fetchCalls.at(-1)!.body) as {
        error: string;
      };
      // The error must mention the failed/malformed finish_turn, not be
      // swallowed into an implicit question.
      assertNotEquals(failed.error.indexOf("finish_turn"), -1);
    } finally {
      await cleanup();
    }
  });
});

Deno.test("malformed finish_turn (no error, missing output) → protocol failure, not implicit question", async () => {
  // finish_turn was called and returned no error, but the output is missing
  // (no `output.outcome`). This is a malformed call — a protocol failure,
  // never an implicit question.
  await withExitCode(async () => {
    const cb = makeCallbackDeps();
    const malformedFinishTurn: Message = {
      role: "tool",
      contents: [{
        toolResult: {
          id: "finish-turn-1",
          name: "finish_turn",
          result: {},
        },
      }],
    };
    const agent = makeFakeAgentFactory({
      extraEmissions: [malformedFinishTurn, modelMessage("my answer")],
    });
    const { config, cleanup } = await makeConfig();
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 1);
      assertEquals(eventKinds(cb.fetchCalls), [
        "turn.running",
        "message.appended",
        "message.appended",
        "turn.failed",
      ]);
      const failed = decodeBody(cb.fetchCalls.at(-1)!.body) as {
        error: string;
      };
      assertNotEquals(failed.error.indexOf("finish_turn"), -1);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 14. turn.finished 409 → exit 1, NO turn.failed (never switch terminals)
// ---------------------------------------------------------------------------

Deno.test("turn.finished 409 → exit 1, no turn.failed attempted (never switch terminals)", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps({
      byKey: { [`${TURN_ID}:terminal`]: [response(409)] },
    });
    const agent = makeFakeAgentFactory({
      extraEmissions: [modelMessage("ok"), finishTurnMessage("completion")],
    });
    const { config, cleanup } = await makeConfig();
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 1);
      // turn.running + 2 message.appended + one terminal attempt (turn.finished).
      // No second terminal attempt (no turn.failed).
      assertEquals(eventKinds(cb.fetchCalls), [
        "turn.running",
        "message.appended",
        "message.appended",
        "turn.finished",
      ]);
      assertEquals(terminalKeyCount(cb.fetchCalls), 1);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 15. turn.failed delivery itself fails → exit 1, no further attempts
// ---------------------------------------------------------------------------

Deno.test("turn.failed delivery itself fails (409) → exit 1, no further attempts", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps({
      byKey: {
        // Agent loop throws a non-callback error → runner attempts turn.failed,
        // which itself gets 409. The runner must give up after one terminal
        // attempt and exit non-zero.
        [`${TURN_ID}:terminal`]: [response(409)],
      },
    });
    const agent = makeFakeAgentFactory({
      extraEmissions: [modelMessage("partial")],
      throwAfterAll: true,
      throwError: new Error("agent blew up"),
    });
    const { config, cleanup } = await makeConfig();
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 1);
      // turn.running + 1 message.appended + one turn.failed attempt (rejected).
      // No second turn.failed attempt.
      assertEquals(eventKinds(cb.fetchCalls), [
        "turn.running",
        "message.appended",
        "turn.failed",
      ]);
      assertEquals(terminalKeyCount(cb.fetchCalls), 1);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 16. loadManagedInput fails → turn.failed, no turn.running
// ---------------------------------------------------------------------------

Deno.test("loadManagedInput fails (missing file) → turn.failed, no turn.running", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps();
    const agent = makeFakeAgentFactory({
      extraEmissions: [finishTurnMessage("completion")],
    });
    // A path that does not exist — loadManagedInput throws.
    const { config, cleanup } = await makeConfig({
      historyPath: "/nonexistent/path/to/history.json",
    });
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 1);
      // Only turn.failed was attempted; no turn.running.
      assertEquals(eventKinds(cb.fetchCalls), ["turn.failed"]);
      assertEquals(terminalKeyCount(cb.fetchCalls), 1);
      assertEquals(agent.runCallCount(), 0);
      const failed = decodeBody(cb.fetchCalls.at(-1)!.body) as {
        error: string;
      };
      assertNotEquals(failed.error.indexOf("--history"), -1);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 17. agentFactory throws → turn.failed, no turn.running
// ---------------------------------------------------------------------------

Deno.test("agentFactory throws (setup failure) → turn.failed, no turn.running", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps();
    const failingFactory = (_config: ManagedConfig): Promise<SetupResult> =>
      Promise.reject(new Error("managedSetup blew up"));
    const { config, cleanup } = await makeConfig();
    const errors: string[] = [];
    try {
      await runManagedTurn(config, {
        agentFactory: failingFactory,
        callbackDeps: cb.deps,
        logError: (message) => errors.push(message),
      });
      assertEquals(Deno.exitCode, 1);
      // Input loaded but agentFactory failed: only turn.failed attempted.
      assertEquals(eventKinds(cb.fetchCalls), ["turn.failed"]);
      assertEquals(terminalKeyCount(cb.fetchCalls), 1);
      const failed = decodeBody(cb.fetchCalls.at(-1)!.body) as {
        error: string;
      };
      assertNotEquals(failed.error.indexOf("managedSetup blew up"), -1);
      assertEquals(errors, ["[managed:setup] managedSetup blew up"]);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 18. Only one callback request in flight at a time
// ---------------------------------------------------------------------------

Deno.test("only one callback request is in flight at a time (fake fetch asserts non-reentrancy)", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps();
    const agent = makeFakeAgentFactory({
      extraEmissions: [
        modelMessage("a"),
        modelMessage("b"),
        modelMessage("c"),
        finishTurnMessage("completion"),
      ],
    });
    const { config, cleanup } = await makeConfig();
    try {
      // If the runner ever overlapped two fetch calls, the fake fetch would
      // throw "test fetch called reentrantly" and the test would fail.
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 0);
      assertEquals(cb.fetchCalls.length, 6);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 19. At most one terminal idempotency key per Turn
// ---------------------------------------------------------------------------

Deno.test("at most one terminal idempotency key is used per Turn across paths", async () => {
  await withExitCode(async () => {
    // Use the conflict-on-message path so both a message.appended prefix and
    // a turn.failed are delivered, then assert only one terminal key use.
    const cb = makeCallbackDeps({
      byKey: { [`${TURN_ID}:message.appended:1`]: [response(409)] },
    });
    const agent = makeFakeAgentFactory({
      extraEmissions: [modelMessage("first"), finishTurnMessage("completion")],
    });
    const { config, cleanup } = await makeConfig();
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 1);
      assertNotEquals(terminalKeyCount(cb.fetchCalls), 0);
      assertEquals(terminalKeyCount(cb.fetchCalls), 1);
      // The terminal key is exactly `<turn-id>:terminal`.
      const terminalKeys = idempotencyKeys(cb.fetchCalls).filter((k) =>
        k.endsWith(":terminal")
      );
      assertEquals(terminalKeys, [`${TURN_ID}:terminal`]);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 20. No terminal event before earlier message acknowledgements
// ---------------------------------------------------------------------------

Deno.test("all message.appended requests come before any terminal request", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps();
    const agent = makeFakeAgentFactory({
      extraEmissions: [
        modelMessage("a"),
        modelMessage("b"),
        finishTurnMessage("completion"),
      ],
    });
    const { config, cleanup } = await makeConfig();
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 0);
      const events = eventKinds(cb.fetchCalls);
      const firstTerminal = events.findIndex((e) =>
        e === "turn.finished" || e === "turn.failed"
      );
      const lastMessage = events.lastIndexOf("message.appended");
      assertNotEquals(firstTerminal, -1);
      assertNotEquals(lastMessage, -1);
      assertEquals(lastMessage < firstTerminal, true);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 21. Exit code is 0 on happy path, 1 on every other path (cross-cutting)
// ---------------------------------------------------------------------------

Deno.test("Deno.exitCode is restored across tests (sanity)", async () => {
  const prior = Deno.exitCode;
  await withExitCode(() => {
    Deno.exitCode = 7;
    assertEquals(Deno.exitCode, 7);
    return undefined;
  });
  assertEquals(Deno.exitCode, prior);
});

// ---------------------------------------------------------------------------
// 22. Agent factory receives config; run receives split prompt + history
// ---------------------------------------------------------------------------

Deno.test("agentFactory receives the config and run receives the split prompt + history", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps();
    const agent = makeFakeAgentFactory({
      extraEmissions: [finishTurnMessage("completion")],
    });
    const customHistory: Message[] = [
      { role: "user", contents: "u1" },
      { role: "model", contents: [{ text: "m1" }], toolCalls: [] },
      { role: "user", contents: [{ text: "triggering text part" }] },
    ];
    const { config, cleanup } = await makeConfig({
      historyMessages: customHistory,
    });
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 0);
      const { config: receivedConfig, prompt, history } = agent.received();
      assertEquals(receivedConfig, config);
      // The split: prompt = last message's contents, history = the rest.
      assertEquals(prompt, [{ text: "triggering text part" }]);
      assertEquals(history!.length, 2);
      assertEquals((history![0] as Message).role, "user");
      assertEquals((history![1] as Message).role, "model");
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 24. MCP connection cleanup — connections are closed on every exit path
// ---------------------------------------------------------------------------

Deno.test("MCP connections are closed after a successful managed turn", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps();
    let closed = false;
    const fakeConn = {
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    };
    const agent = makeFakeAgentFactory({
      extraEmissions: [finishTurnMessage("completion")],
    });
    const { config, cleanup } = await makeConfig();
    try {
      // Wrap the factory to inject fake MCP connections.
      await runManagedTurn(config, {
        agentFactory: async (cfg) => {
          const result = await agent.factory(cfg);
          return { ...result, mcpConnections: [fakeConn] as never };
        },
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 0);
      assertEquals(closed, true);
    } finally {
      await cleanup();
    }
  });
});

Deno.test("MCP connections are closed when agent.run throws", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps();
    let closed = false;
    const fakeConn = {
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    };
    const agent = makeFakeAgentFactory({
      extraEmissions: [modelMessage("partial")],
      throwAfterAll: true,
      throwError: new Error("provider failed"),
    });
    const { config, cleanup } = await makeConfig();
    try {
      await runManagedTurn(config, {
        agentFactory: async (cfg) => {
          const result = await agent.factory(cfg);
          return { ...result, mcpConnections: [fakeConn] as never };
        },
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 1);
      assertEquals(closed, true);
    } finally {
      await cleanup();
    }
  });
});

Deno.test("MCP connections are closed when agentFactory throws", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps();
    // No connections to close since agentFactory threw before returning them,
    // but the finally block must still run without error.
    const failingFactory = (_config: ManagedConfig): Promise<SetupResult> =>
      Promise.reject(new Error("setup failed"));
    const { config, cleanup } = await makeConfig();
    try {
      await runManagedTurn(config, {
        agentFactory: failingFactory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 1);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 23. Same turn_id across all requests (no new Turn ID for HTTP retries)
// ---------------------------------------------------------------------------

Deno.test("no new Turn ID is created for HTTP retries — all requests carry the same turn_id", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps({
      byKey: {
        [`${TURN_ID}:turn.running`]: [response(500), response(204)],
        [`${TURN_ID}:message.appended:1`]: [response(500), response(204)],
      },
    });
    const agent = makeFakeAgentFactory({
      extraEmissions: [modelMessage("first"), finishTurnMessage("completion")],
    });
    const { config, cleanup } = await makeConfig();
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 0);
      for (const call of cb.fetchCalls) {
        const body = decodeBody(call.body) as { turn_id: string };
        assertEquals(body.turn_id, TURN_ID);
      }
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Additional: assertRejects-style — turn.running fatal-failable (202) → turn.failed
// ---------------------------------------------------------------------------

Deno.test("turn.running 202 → fatal-failable → turn.failed attempted, exit 1", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps({
      byKey: { [`${TURN_ID}:turn.running`]: [response(202)] },
    });
    const agent = makeFakeAgentFactory({
      extraEmissions: [finishTurnMessage("completion")],
    });
    const { config, cleanup } = await makeConfig();
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 1);
      assertEquals(eventKinds(cb.fetchCalls), ["turn.running", "turn.failed"]);
      assertEquals(terminalKeyCount(cb.fetchCalls), 1);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Additional: budget-exhausted on turn.running → turn.failed
// ---------------------------------------------------------------------------

Deno.test("turn.running budget exhausted → turn.failed attempted within terminal window, exit 1", async () => {
  await withExitCode(async () => {
    // Set the deadline 10 s from the clock origin. The non-terminal cutoff is
    // `turnDeadlineMs - 15_000 = -5_000`, so `turn.running`'s first attempt
    // throws `budget-exhausted` before any fetch. The terminal cutoff is
    // `turnDeadlineMs = 10_000`, so the subsequent `turn.failed` delivery can
    // still succeed within the reserved terminal window.
    const cb = makeCallbackDeps({
      turnDeadlineMs: 10_000,
      byKey: { [`${TURN_ID}:terminal`]: [response(204)] },
    });
    const agent = makeFakeAgentFactory({
      extraEmissions: [finishTurnMessage("completion")],
    });
    const { config, cleanup } = await makeConfig({ turnDeadlineMs: 10_000 });
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 1);
      // No turn.running fetch (budget exhausted before the request); exactly
      // one terminal delivery (turn.failed) within the terminal window.
      assertEquals(eventKinds(cb.fetchCalls), ["turn.failed"]);
      assertEquals(terminalKeyCount(cb.fetchCalls), 1);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Model-call retry (ADR 0010): transient agent.run failures are retried in
// place while the callback contract — single terminal, monotonic sequences,
// echo suppression — is preserved on every attempt.
// ---------------------------------------------------------------------------

Deno.test("managed retry: transient agent.run failure is retried and the turn finishes", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps();
    // Attempt 1 throws before emitting anything; attempt 2 completes.
    const agent = makeFakeAgentFactory({
      failFirstRuns: 1,
      throwError: new Error("429 Too Many Requests"),
      extraEmissions: [
        modelMessage("recovered"),
        finishTurnMessage("completion"),
      ],
    });
    const { config, cleanup } = await makeConfig({ retries: 2 });
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 0);
      assertEquals(agent.runCallCount(), 2);
      // One backoff sleep for the one retry; delivery itself never retried.
      assertEquals(cb.sleepCalls.length, 1);
      assertEquals(eventKinds(cb.fetchCalls), [
        "turn.running",
        "message.appended",
        "message.appended",
        "turn.finished",
      ]);
      assertEquals(terminalKeyCount(cb.fetchCalls), 1);
      assertEquals(idempotencyKeys(cb.fetchCalls), [
        `${TURN_ID}:turn.running`,
        `${TURN_ID}:message.appended:1`,
        `${TURN_ID}:message.appended:2`,
        `${TURN_ID}:terminal`,
      ]);
    } finally {
      await cleanup();
    }
  });
});

Deno.test("managed retry: delivered prefix keeps its sequences and the echo is re-suppressed after a mid-loop transient failure", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps();
    // Attempt 1 emits the triggering user message (suppressed), one model
    // message (delivered as sequence 1), then fails transiently mid-loop.
    // Attempt 2 re-emits the user message (re-suppressed) and completes.
    let runs = 0;
    const run: Assistant["run"] = async (prompt, _history, options) => {
      runs += 1;
      const emissions: Message[] = [
        { role: "user", contents: prompt as string },
      ];
      if (runs === 1) {
        emissions.push(modelMessage("working"));
      } else {
        emissions.push(
          modelMessage("second try"),
          finishTurnMessage("completion"),
        );
      }
      const messages: Message[] = [];
      for (const emission of emissions) {
        await options?.onMessage?.(emission);
        messages.push(emission);
      }
      if (runs === 1) throw new Error("503 Service Unavailable");
      return messages;
    };
    const factory = async (_config: ManagedConfig): Promise<SetupResult> => ({
      assistant: { run },
      mcpConnections: [],
    });
    const { config, cleanup } = await makeConfig({ retries: 2 });
    try {
      await runManagedTurn(config, {
        agentFactory: factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 0);
      assertEquals(runs, 2);
      // Sequences continue monotonically from the delivered prefix: the
      // attempt-1 model message stays sequence 1; attempt 2's messages are 2
      // and 3. The re-emitted triggering user message is never delivered.
      const seqs = cb.fetchCalls
        .map((c) =>
          (decodeBody(c.body) as { turn_sequence?: number }).turn_sequence
        )
        .filter((v) => v !== undefined);
      assertEquals(seqs, [1, 2, 3]);
      assertEquals(eventKinds(cb.fetchCalls), [
        "turn.running",
        "message.appended",
        "message.appended",
        "message.appended",
        "turn.finished",
      ]);
      assertEquals(terminalKeyCount(cb.fetchCalls), 1);
      assertEquals(cb.sleepCalls.length, 1);
    } finally {
      await cleanup();
    }
  });
});

Deno.test("managed retry: exhausted transient failures produce exactly one turn.failed and exit 1", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps();
    const agent = makeFakeAgentFactory({
      failFirstRuns: 99,
      throwError: new Error("503 Service Unavailable"),
    });
    const { config, cleanup } = await makeConfig({ retries: 2 });
    const errors: string[] = [];
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
        logError: (message) => errors.push(message),
      });
      assertEquals(Deno.exitCode, 1);
      // Initial attempt + 2 retries, then the existing failure path.
      assertEquals(agent.runCallCount(), 3);
      assertEquals(cb.sleepCalls.length, 2);
      assertEquals(eventKinds(cb.fetchCalls), [
        "turn.running",
        "turn.failed",
      ]);
      assertEquals(terminalKeyCount(cb.fetchCalls), 1);
      // The last error is reported unchanged.
      assertEquals(errors, ["[managed:agent.run] 503 Service Unavailable"]);
    } finally {
      await cleanup();
    }
  });
});

Deno.test("managed retry: a permanent model failure fails immediately without retrying", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps();
    const agent = makeFakeAgentFactory({
      failFirstRuns: 99,
      throwError: new Error("401 invalid api key"),
    });
    const { config, cleanup } = await makeConfig({ retries: 2 });
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 1);
      assertEquals(agent.runCallCount(), 1);
      assertEquals(cb.sleepCalls.length, 0);
      assertEquals(eventKinds(cb.fetchCalls), [
        "turn.running",
        "turn.failed",
      ]);
    } finally {
      await cleanup();
    }
  });
});

Deno.test("managed retry: no attempt starts once the terminal reserve is reached", async () => {
  await withExitCode(async () => {
    const cb = makeCallbackDeps();
    const agent = makeFakeAgentFactory({
      failFirstRuns: 99,
      throwError: new Error("overloaded"),
    });
    // Deadline 30_000 ms → retry cutoff 15_000 ms. With random() = 0 the
    // backoffs are 125, 250, 500, 1000, then 2500 each (the 5 s cap): the
    // 10th attempt starts at 13_875 ms, and the sleep after its failure
    // crosses the cutoff — so the loop stops there, keeping the final 15 s
    // reserved for terminal delivery. retries uses the parser's maximum of
    // 10 (the cutoff would bind before the 11th attempt anyway).
    const { config, cleanup } = await makeConfig({
      retries: 10,
      turnDeadlineMs: 30_000,
    });
    try {
      await runManagedTurn(config, {
        agentFactory: agent.factory,
        callbackDeps: cb.deps,
      });
      assertEquals(Deno.exitCode, 1);
      assertEquals(agent.runCallCount(), 10);
      assertEquals(cb.sleepCalls, [
        125, 250, 500, 1000, 2000, 2500, 2500, 2500, 2500, 2500,
      ]);
      assertEquals(cb.clock(), 16_375);
      assertEquals(eventKinds(cb.fetchCalls), [
        "turn.running",
        "turn.failed",
      ]);
      assertEquals(terminalKeyCount(cb.fetchCalls), 1);
    } finally {
      await cleanup();
    }
  });
});