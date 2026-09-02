import { assertEquals, assertStringIncludes } from "@std/assert";
import type { Message } from "@huuma/ai/agent";
import {
  type Assistant,
  chat,
  modelText,
  respond,
  showToolCalls,
} from "./chat.ts";
import type { RetryDeps } from "./retry.ts";
import { quiet } from "./testing.ts";

function modelReply(text: string): Message {
  return { role: "model", contents: [{ text }], toolCalls: [] };
}

/** The prompt type `Assistant.run` accepts, derived so the fakes below track
 * @huuma/ai (which widened it beyond `string` for media input). */
type RunPrompt = Parameters<Assistant["run"]>[0];

Deno.test("modelText returns the text of the last model message", () => {
  const messages: Message[] = [
    { role: "user", contents: "Hi" },
    { role: "model", contents: [{ text: "Hello!" }], toolCalls: [] },
    { role: "user", contents: "How are you?" },
    { role: "model", contents: [{ text: "Great." }], toolCalls: [] },
  ];
  assertEquals(modelText(messages), "Great.");
});

Deno.test("modelText skips trailing non-model messages", () => {
  const messages: Message[] = [
    { role: "model", contents: [{ text: "Done." }], toolCalls: [] },
    {
      role: "tool",
      contents: [{
        toolResult: { id: "1", name: "cli", result: { output: "ok" } },
      }],
    },
  ];
  assertEquals(modelText(messages), "Done.");
});

Deno.test("modelText joins multiple text contents and ignores tool calls", () => {
  const toolCall = { toolCall: { id: "1", name: "cli", props: {} } };
  const messages: Message[] = [
    {
      role: "model",
      contents: [{ text: "First." }, toolCall, { text: "Second." }],
      toolCalls: [toolCall.toolCall],
    },
  ];
  assertEquals(modelText(messages), "First.\nSecond.");
});

Deno.test("modelText falls back when no model text exists", () => {
  assertEquals(modelText([]), "(no response)");
  assertEquals(
    modelText([{ role: "user", contents: "Hi" }]),
    "(no response)",
  );
});

Deno.test("respond returns the conversation from a successful run", async () => {
  const conversation: Message[] = [
    { role: "user", contents: "Hi" },
    modelReply("Hello!"),
  ];
  const assistant: Assistant = { run: () => Promise.resolve(conversation) };

  const result = await quiet(() => respond(assistant, "Hi", []));

  assertEquals(result, { messages: conversation, ok: true });
});

Deno.test("respond threads the prompt and prior history into run", async () => {
  const history: Message[] = [
    { role: "user", contents: "Hi" },
    modelReply("Hello!"),
  ];
  let seen: { prompt: RunPrompt; history?: Message[] } | undefined;
  const assistant: Assistant = {
    run: (prompt, history) => {
      seen = { prompt, history };
      return Promise.resolve([...(history ?? []), modelReply("Sure.")]);
    },
  };

  await quiet(() => respond(assistant, "Tell me more", history));

  assertEquals(seen, { prompt: "Tell me more", history });
});

Deno.test("respond surfaces tool-call names through its retry-aware onMessage", async () => {
  // respond wraps showToolCalls (it also records emissions for the retry
  // resume), so the hook is verified behaviorally: requested tool names must
  // still print live.
  const lines: string[] = [];
  const { log } = console;
  const writeSync = Deno.stdout.writeSync.bind(Deno.stdout);
  console.log = (line: unknown) => lines.push(String(line));
  Deno.stdout.writeSync = () => 0;
  try {
    const toolCallMessage: Message = {
      role: "model",
      contents: [],
      toolCalls: [{ id: "1", name: "grep", props: {} }],
    };
    const assistant: Assistant = {
      run: (_prompt, _history, opts) => {
        opts?.onMessage?.(toolCallMessage);
        return Promise.resolve([modelReply("done")]);
      },
    };
    await respond(assistant, "Hi", [], { retries: 0 });
  } finally {
    console.log = log;
    Deno.stdout.writeSync = writeSync;
  }

  assertStringIncludes(lines.join("\n"), "grep");
});

Deno.test("showToolCalls prints one line per requested tool call", () => {
  const lines: string[] = [];
  const { log } = console;
  const writeSync = Deno.stdout.writeSync.bind(Deno.stdout);
  console.log = (line: unknown) => {
    lines.push(String(line));
  };
  Deno.stdout.writeSync = () => 0;
  try {
    showToolCalls({
      role: "model",
      contents: [],
      toolCalls: [
        { id: "1", name: "grep", props: {} },
        { id: "2", name: "read_file", props: {} },
      ],
    });
    // Messages without tool calls stay silent.
    showToolCalls(modelReply("plain answer"));
    showToolCalls({ role: "user", contents: "Hi" });
    // A model message missing toolCalls entirely (loosely-typed adapter).
    showToolCalls(
      { role: "model", contents: [{ text: "hi" }] } as unknown as Message,
    );
  } finally {
    console.log = log;
    Deno.stdout.writeSync = writeSync;
  }

  assertEquals(lines.length, 2);
  assertStringIncludes(lines[0], "grep");
  assertStringIncludes(lines[1], "read_file");
});

Deno.test("respond keeps the prior history when run fails", async () => {
  const history: Message[] = [
    { role: "user", contents: "Hi" },
    modelReply("Hello!"),
  ];
  const assistant: Assistant = {
    run: () => Promise.reject(new Error("rate limited")),
  };

  const result = await quiet(() =>
    respond(assistant, "next", history, { retries: 0 })
  );

  assertEquals(result, { messages: history, ok: false });
});

Deno.test("chat answers a one-shot prompt, runs once, and returns ''", async () => {
  const calls: { prompt: RunPrompt; history?: Message[] }[] = [];
  const assistant: Assistant = {
    run: (prompt, history) => {
      calls.push({ prompt, history });
      return Promise.resolve([
        { role: "user", contents: prompt },
        modelReply("hi"),
      ]);
    },
  };

  const result = await quiet(() => chat(assistant, "hello there"));

  // one-shot returns "" (not the REPL's "Bye!") and never enters the loop
  assertEquals(result, "");
  assertEquals(calls, [{ prompt: "hello there", history: [] }]);
});

Deno.test("chat flags a failed one-shot with a non-zero exit code", async () => {
  const priorExitCode = Deno.exitCode;
  try {
    const assistant: Assistant = {
      run: () => Promise.reject(new Error("boom")),
    };

    const result = await quiet(() => chat(assistant, "hi", [], { retries: 0 }));

    assertEquals(result, ""); // still returns the one-shot sentinel
    assertEquals(Deno.exitCode, 1); // failure surfaces via the exit code
  } finally {
    Deno.exitCode = priorExitCode;
  }
});

Deno.test("chat closes MCP connections after a one-shot", async () => {
  let closed = false;
  const assistant: Assistant = {
    run: () => Promise.resolve([modelReply("hi")]),
  };
  const fakeConn = { close: () => { closed = true; return Promise.resolve(); } };

  await quiet(() => chat(assistant, "hello", [fakeConn as never]));

  assertEquals(closed, true);
});

Deno.test("chat closes MCP connections even when run throws", async () => {
  const priorExitCode = Deno.exitCode;
  let closed = false;
  const assistant: Assistant = {
    run: () => Promise.reject(new Error("boom")),
  };
  const fakeConn = { close: () => { closed = true; return Promise.resolve(); } };

  try {
    await quiet(() =>
      chat(assistant, "hello", [fakeConn as never], { retries: 0 })
    );
    assertEquals(closed, true);
  } finally {
    Deno.exitCode = priorExitCode;
  }
});

// ---------------------------------------------------------------------------
// Model-call retry in local chat (ADR 0010)
// ---------------------------------------------------------------------------

/** Fake retry timing: sleeps are recorded, never awaited for real, so the
 * retry loop is deterministic and instant. */
function instantRetryDeps(): { deps: RetryDeps; sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    deps: {
      now: () => new Date(0),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 0,
    },
    sleeps,
  };
}

Deno.test("respond retries a transient failure and succeeds", async () => {
  const { deps, sleeps } = instantRetryDeps();
  let calls = 0;
  const conversation: Message[] = [
    { role: "user", contents: "Hi" },
    modelReply("Hello!"),
  ];
  const assistant: Assistant = {
    run: () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("429 rate limited"));
      return Promise.resolve(conversation);
    },
  };

  const result = await quiet(() =>
    respond(assistant, "Hi", [], { retries: 2, retryDeps: deps })
  );

  assertEquals(result, { messages: conversation, ok: true });
  assertEquals(calls, 2);
  assertEquals(sleeps, [125]); // 250 × 0.5 jitter (random() = 0)
});

Deno.test("respond does not retry a permanent failure", async () => {
  const { deps, sleeps } = instantRetryDeps();
  let calls = 0;
  const assistant: Assistant = {
    run: () => {
      calls += 1;
      return Promise.reject(new Error("401 invalid api key"));
    },
  };

  const result = await quiet(() =>
    respond(assistant, "next", [], { retries: 2, retryDeps: deps })
  );

  assertEquals(result.ok, false);
  assertEquals(calls, 1);
  assertEquals(sleeps, []);
});

Deno.test("respond exhausts retries and keeps today's failure behavior", async () => {
  const history: Message[] = [{ role: "user", contents: "prior" }];
  const { deps, sleeps } = instantRetryDeps();
  let calls = 0;
  const assistant: Assistant = {
    run: () => {
      calls += 1;
      return Promise.reject(new Error("503 overloaded"));
    },
  };

  const result = await quiet(() =>
    respond(assistant, "next", history, { retries: 2, retryDeps: deps })
  );

  assertEquals(result, { messages: history, ok: false });
  assertEquals(calls, 3); // initial + 2 retries
  assertEquals(sleeps, [125, 250]);
});

Deno.test("respond resumes with emitted messages minus the triggering user echo, so executed tools are not re-run", async () => {
  const { deps } = instantRetryDeps();
  const history: Message[] = [
    { role: "user", contents: "earlier" },
    modelReply("earlier reply"),
  ];
  const toolCallMessage: Message = {
    role: "model",
    contents: [],
    toolCalls: [{ id: "1", name: "grep", props: {} }],
  };
  const toolResultMessage: Message = {
    role: "tool",
    contents: [{
      toolResult: { id: "1", name: "grep", result: { output: "hits" } },
    }],
  };
  const histories: (Message[] | undefined)[] = [];
  let calls = 0;
  // Attempt 1 executes the tool (emitted via onMessage, mirroring
  // @huuma/ai), then the provider fails transiently. Attempt 2 sees the
  // executed work as prior history and finishes without re-running it.
  const assistant: Assistant = {
    run: (prompt, runHistory, opts) => {
      calls += 1;
      histories.push(runHistory);
      const echo: Message = { role: "user", contents: prompt };
      if (calls === 1) {
        opts?.onMessage?.(echo);
        opts?.onMessage?.(toolCallMessage);
        opts?.onMessage?.(toolResultMessage);
        return Promise.reject(new Error("connection reset by peer"));
      }
      return Promise.resolve([echo, modelReply("done")]);
    },
  };

  const result = await quiet(() =>
    respond(assistant, "fix it", history, { retries: 2, retryDeps: deps })
  );

  assertEquals(result.ok, true);
  // Attempt 1 got the original history; attempt 2 received the original
  // history plus the attempt-1 emissions minus the re-emitted triggering
  // user message.
  assertEquals(histories[0], history);
  assertEquals(histories[1], [...history, toolCallMessage, toolResultMessage]);
});

Deno.test("respond prints a dim sanitized one-line notice per retry", async () => {
  const { deps } = instantRetryDeps();
  const lines: string[] = [];
  const { error } = console;
  console.error = (line: unknown) => lines.push(String(line));
  try {
    let calls = 0;
    const assistant: Assistant = {
      run: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(
            new Error("429 rate limited for key sk-abcdef1234567890abcdef"),
          );
        }
        return Promise.resolve([modelReply("ok")]);
      },
    };
    await respond(assistant, "Hi", [], { retries: 2, retryDeps: deps });
  } finally {
    console.error = error;
  }

  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0], "retry 1/2");
  assertStringIncludes(lines[0], "125ms");
  // sanitizeError redaction applied, and the notice stays on one line.
  assertStringIncludes(lines[0], "sk-[redacted]");
  assertEquals(lines[0].includes("\n"), false);
});
