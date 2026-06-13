import { assertEquals, assertRejects } from "@std/assert";
import type { Message } from "@huuma/ai/agent";
import agentCommand, {
  type Assistant,
  chat,
  modelText,
  ollamaApiKey,
  resolveApiKey,
  resolveModel,
  respond,
  setup,
} from "./agent.ts";

/** Runs `fn` with terminal output suppressed so the REPL chrome
 * ("Thinking...", colors, error lines) stays out of the test report. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const { log, error } = console;
  const writeSync = Deno.stdout.writeSync.bind(Deno.stdout);
  console.log = () => {};
  console.error = () => {};
  Deno.stdout.writeSync = () => 0;
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
    Deno.stdout.writeSync = writeSync;
  }
}

function modelReply(text: string): Message {
  return { role: "model", contents: [{ text }], toolCalls: [] };
}

/** Sets env vars (a `null` value clears one) for the duration of `fn`, then
 * restores the prior environment. Requires `--allow-env`. */
async function withEnv(
  vars: Record<string, string | null>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const prior = new Map(
    Object.keys(vars).map((key) => [key, Deno.env.get(key)]),
  );
  for (const [key, value] of Object.entries(vars)) {
    if (value === null) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

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
  let seen: { prompt: string; history?: Message[] } | undefined;
  const assistant: Assistant = {
    run: (prompt, history) => {
      seen = { prompt, history };
      return Promise.resolve([...(history ?? []), modelReply("Sure.")]);
    },
  };

  await quiet(() => respond(assistant, "Tell me more", history));

  assertEquals(seen, { prompt: "Tell me more", history });
});

Deno.test("respond keeps the prior history when run fails", async () => {
  const history: Message[] = [
    { role: "user", contents: "Hi" },
    modelReply("Hello!"),
  ];
  const assistant: Assistant = {
    run: () => Promise.reject(new Error("rate limited")),
  };

  const result = await quiet(() => respond(assistant, "next", history));

  assertEquals(result, { messages: history, ok: false });
});

Deno.test("chat answers a one-shot prompt, runs once, and returns ''", async () => {
  const calls: { prompt: string; history?: Message[] }[] = [];
  const assistant: Assistant = {
    run: (prompt, history) => {
      calls.push({ prompt, history });
      return Promise.resolve([
        { role: "user", contents: prompt },
        modelReply("hi"),
      ]);
    },
  };

  const result = await quiet(() => chat(assistant, ["hello", "there"]));

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

    const result = await quiet(() => chat(assistant, ["hi"]));

    assertEquals(result, ""); // still returns the one-shot sentinel
    assertEquals(Deno.exitCode, 1); // failure surfaces via the exit code
  } finally {
    Deno.exitCode = priorExitCode;
  }
});

Deno.test("resolveModel returns HUUMA_AGENT_MODEL without prompting", async () => {
  await withEnv({ HUUMA_AGENT_MODEL: "claude-opus-4-8" }, async () => {
    assertEquals(await resolveModel("fallback-model"), "claude-opus-4-8");
  });
});

Deno.test("resolveApiKey prefers HUUMA_AGENT_API_KEY over the provider var", async () => {
  await withEnv(
    { HUUMA_AGENT_API_KEY: "generic", OPENAI_API_KEY: "provider" },
    async () => {
      assertEquals(await resolveApiKey("OPENAI_API_KEY", "OpenAI"), "generic");
    },
  );
});

Deno.test("resolveApiKey falls back to the provider's own variable", async () => {
  await withEnv(
    { HUUMA_AGENT_API_KEY: null, ANTHROPIC_API_KEY: "provider" },
    async () => {
      assertEquals(
        await resolveApiKey("ANTHROPIC_API_KEY", "Anthropic"),
        "provider",
      );
    },
  );
});

Deno.test("setup rejects an unknown HUUMA_AGENT_PROVIDER", async () => {
  await withEnv({ HUUMA_AGENT_PROVIDER: "gemini" }, async () => {
    await assertRejects(() => setup(), Error, 'Unknown provider "gemini"');
  });
});

Deno.test("the agent command renders a setup failure instead of crashing", async () => {
  const priorExitCode = Deno.exitCode;
  try {
    await withEnv({ HUUMA_AGENT_PROVIDER: "gemini" }, async () => {
      const result = await quiet(() => agentCommand(["hi"]));
      assertEquals(result, ""); // handled cleanly, not thrown
      assertEquals(Deno.exitCode, 1);
    });
  } finally {
    Deno.exitCode = priorExitCode;
  }
});

Deno.test("ollamaApiKey prefers HUUMA_AGENT_API_KEY, then OLLAMA_API_KEY", async () => {
  await withEnv(
    { HUUMA_AGENT_API_KEY: "generic", OLLAMA_API_KEY: "ollama" },
    () => assertEquals(ollamaApiKey(), "generic"),
  );
  await withEnv(
    { HUUMA_AGENT_API_KEY: null, OLLAMA_API_KEY: "ollama" },
    () => assertEquals(ollamaApiKey(), "ollama"),
  );
  await withEnv(
    { HUUMA_AGENT_API_KEY: null, OLLAMA_API_KEY: null },
    () => assertEquals(ollamaApiKey(), undefined),
  );
});
