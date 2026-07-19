import { assertEquals, assertObjectMatch, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { Message } from "@huuma/ai/agent";
import type { ManagedConfig } from "./config.ts";
import { loadManagedInput } from "./input.ts";

/** Minimal {@link ManagedConfig} for input tests: only `historyPath` is read
 * by `loadManagedInput`; the rest is filled with valid-shaped placeholders so
 * the object satisfies the type without distracting from the field under
 * test. */
function configWithHistory(historyPath: string): ManagedConfig {
  return {
    callbackUrl: new URL("https://example.test/callback"),
    runId: "00000000-0000-0000-0000-000000000000",
    turnId: "00000000-0000-0000-0000-000000000001",
    turnDeadline: new Date(Date.now() + 60_000),
    historyPath,
    cwd: ".",
    model: { provider: "anthropic", modelId: "claude-haiku-4-5" },
    host: undefined,
    tools: [],
    cliCommands: [],
    systemPrompt: undefined,
    searchEngine: undefined,
    skillsPath: undefined,
    callbackSecret: "secret",
  };
}

/** Writes `contents` to `path` inside a fresh temp dir and returns both. */
async function writeHistory(
  contents: string,
): Promise<{ dir: string; path: string }> {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "history.json");
  await Deno.writeTextFile(path, contents);
  return { dir, path };
}

/** Recursively removes a temp dir, ignoring errors so a test failure above
 * never masks the original assertion error. */
async function cleanup(dir: string): Promise<void> {
  try {
    await Deno.remove(dir, { recursive: true });
  } catch {
    // ignore — best-effort cleanup
  }
}

Deno.test("loadManagedInput splits [user, model, user] into prompt + history", async () => {
  const messages: Message[] = [
    { role: "user", contents: "first" },
    {
      role: "model",
      contents: [{ text: "hi" }],
      toolCalls: [],
    },
    { role: "user", contents: "triggering" },
  ];
  const { dir, path } = await writeHistory(JSON.stringify(messages));
  try {
    const { prompt, history } = await loadManagedInput(configWithHistory(path));
    // The triggering user message's contents become the prompt verbatim.
    assertEquals(prompt, "triggering");
    // All preceding messages are the history, preserved verbatim.
    assertEquals(history.length, 2);
    assertEquals(history[0], messages[0]);
    assertEquals(history[1], messages[1]);
  } finally {
    await cleanup(dir);
  }
});

Deno.test("loadManagedInput accepts a (TextContent | FileContent)[] prompt", async () => {
  const contents = [
    { text: "look at this" },
    { file: { mimeType: "image/png", data: "base64-bytes" } },
  ];
  const messages = [
    { role: "user", contents: "earlier" },
    { role: "user", contents },
  ];
  const { dir, path } = await writeHistory(JSON.stringify(messages));
  try {
    const { prompt, history } = await loadManagedInput(configWithHistory(path));
    // The array form passes through verbatim — no field rewriting, no
    // lossy string conversion.
    assertEquals(prompt, contents);
    assertEquals(history.length, 1);
    assertEquals(history[0], { role: "user", contents: "earlier" });
  } finally {
    await cleanup(dir);
  }
});

Deno.test("loadManagedInput accepts a single-message history (just the triggering user)", async () => {
  const messages = [{ role: "user", contents: "hello" }];
  const { dir, path } = await writeHistory(JSON.stringify(messages));
  try {
    const { prompt, history } = await loadManagedInput(configWithHistory(path));
    assertEquals(prompt, "hello");
    // No preceding messages: history is empty, not undefined.
    assertEquals(history, []);
  } finally {
    await cleanup(dir);
  }
});

Deno.test("loadManagedInput preserves model messages verbatim (toolCalls, thinking, thinkingMeta)", async () => {
  const modelMessage = {
    role: "model",
    contents: [{ text: "thinking…" }],
    toolCalls: [
      { id: "call_1", name: "grep", input: { pattern: "foo" } },
    ],
    thinking: "internal reasoning",
    thinkingMeta: { signature: "sig", redacted: null },
  };
  const messages = [
    { role: "user", contents: "find foo" },
    modelMessage,
    { role: "user", contents: "thanks" },
  ];
  const { dir, path } = await writeHistory(JSON.stringify(messages));
  try {
    const { history } = await loadManagedInput(configWithHistory(path));
    assertEquals(history.length, 2);
    // Object match — every field is preserved without stripping or
    // rewriting. The PLAN forbids filtering, repairing, or truncating.
    assertObjectMatch(
      history[1] as unknown as Record<string, unknown>,
      modelMessage,
    );
    assertEquals(
      (history[1] as { thinkingMeta: unknown }).thinkingMeta,
      modelMessage.thinkingMeta,
    );
  } finally {
    await cleanup(dir);
  }
});

Deno.test("loadManagedInput rejects an empty array", async () => {
  const { dir, path } = await writeHistory("[]");
  try {
    await assertRejects(
      () => loadManagedInput(configWithHistory(path)),
      Error,
      "--history must be a non-empty array of messages",
    );
  } finally {
    await cleanup(dir);
  }
});

Deno.test("loadManagedInput rejects a non-user final message", async () => {
  const messages = [
    { role: "user", contents: "hi" },
    { role: "model", contents: [{ text: "hello" }], toolCalls: [] },
  ];
  const { dir, path } = await writeHistory(JSON.stringify(messages));
  try {
    await assertRejects(
      () => loadManagedInput(configWithHistory(path)),
      Error,
      "--history must end with a user message",
    );
  } finally {
    await cleanup(dir);
  }
});

Deno.test("loadManagedInput rejects an entry missing a role", async () => {
  const messages = [
    { role: "user", contents: "hi" },
    { contents: "no role" },
  ];
  const { dir, path } = await writeHistory(JSON.stringify(messages));
  try {
    await assertRejects(
      () => loadManagedInput(configWithHistory(path)),
      Error,
      "--history[1] is missing a role",
    );
  } finally {
    await cleanup(dir);
  }
});

Deno.test("loadManagedInput rejects an entry with an invalid role value", async () => {
  const messages = [
    { role: "user", contents: "hi" },
    { role: "assistant", contents: "bad role" },
  ];
  const { dir, path } = await writeHistory(JSON.stringify(messages));
  try {
    await assertRejects(
      () => loadManagedInput(configWithHistory(path)),
      Error,
      '--history[1] has invalid role "assistant"',
    );
  } finally {
    await cleanup(dir);
  }
});

Deno.test("loadManagedInput rejects an entry missing contents", async () => {
  const messages = [
    { role: "user", contents: "hi" },
    { role: "model" },
  ];
  const { dir, path } = await writeHistory(JSON.stringify(messages));
  try {
    await assertRejects(
      () => loadManagedInput(configWithHistory(path)),
      Error,
      "--history[1] is missing contents",
    );
  } finally {
    await cleanup(dir);
  }
});

Deno.test("loadManagedInput rejects a non-object entry", async () => {
  const messages = [{ role: "user", contents: "hi" }, "not a message"];
  const { dir, path } = await writeHistory(JSON.stringify(messages));
  try {
    await assertRejects(
      () => loadManagedInput(configWithHistory(path)),
      Error,
      "--history[1] is not a message object",
    );
  } finally {
    await cleanup(dir);
  }
});

Deno.test("loadManagedInput rejects an unreadable file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "does-not-exist.json");
    await assertRejects(
      () => loadManagedInput(configWithHistory(path)),
      Error,
      "--history file is unreadable:",
    );
  } finally {
    await cleanup(dir);
  }
});

Deno.test("loadManagedInput rejects invalid JSON", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "bad.json");
  await Deno.writeTextFile(path, "{not json");
  try {
    await assertRejects(
      () => loadManagedInput(configWithHistory(path)),
      Error,
      "--history file is not valid JSON:",
    );
  } finally {
    await cleanup(dir);
  }
});

Deno.test("loadManagedInput rejects non-array JSON (string)", async () => {
  const { dir, path } = await writeHistory(JSON.stringify("hello"));
  try {
    await assertRejects(
      () => loadManagedInput(configWithHistory(path)),
      Error,
      "--history must be a non-empty array of messages",
    );
  } finally {
    await cleanup(dir);
  }
});

Deno.test("loadManagedInput rejects non-array JSON (object)", async () => {
  const { dir, path } = await writeHistory(JSON.stringify({ role: "user" }));
  try {
    await assertRejects(
      () => loadManagedInput(configWithHistory(path)),
      Error,
      "--history must be a non-empty array of messages",
    );
  } finally {
    await cleanup(dir);
  }
});

Deno.test("loadManagedInput rejects non-array JSON (null)", async () => {
  const { dir, path } = await writeHistory("null");
  try {
    await assertRejects(
      () => loadManagedInput(configWithHistory(path)),
      Error,
      "--history must be a non-empty array of messages",
    );
  } finally {
    await cleanup(dir);
  }
});

Deno.test("loadManagedInput does not change the process working directory", async () => {
  const before = Deno.cwd();
  const messages = [{ role: "user", contents: "hi" }];
  const { dir, path } = await writeHistory(JSON.stringify(messages));
  try {
    await loadManagedInput(configWithHistory(path));
    assertEquals(Deno.cwd(), before);
  } finally {
    await cleanup(dir);
  }
});

Deno.test("loadManagedInput resolves a relative --history path against the invocation cwd", async () => {
  // Save and restore the process cwd around this test: a relative
  // --history path must resolve against the cwd at call time, not against
  // --cwd (which loadManagedInput never applies).
  const originalCwd = Deno.cwd();
  const dir = await Deno.makeTempDir();
  try {
    Deno.chdir(dir);
    await Deno.writeTextFile(
      join(dir, "history.json"),
      JSON.stringify([{ role: "user", contents: "relative" }]),
    );
    const { prompt } = await loadManagedInput(
      configWithHistory("history.json"),
    );
    assertEquals(prompt, "relative");
  } finally {
    Deno.chdir(originalCwd);
    await cleanup(dir);
  }
});

Deno.test("loadManagedInput error messages never include file contents or the callback secret", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "bad.json");
  // A file whose contents look like a secret; the error must name the path
  // and the JSON reason, never the file body.
  await Deno.writeTextFile(path, "super-secret-value-not-json");
  try {
    await loadManagedInput(configWithHistory(path));
    throw new Error("expected loadManagedInput to reject");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("--history file is not valid JSON:")) {
      throw new Error(`unexpected error: ${message}`);
    }
    if (message.includes("super-secret-value-not-json")) {
      throw new Error(`error leaked file contents: ${message}`);
    }
    if (message.includes("secret")) {
      throw new Error(`error leaked the callback secret: ${message}`);
    }
  } finally {
    await cleanup(dir);
  }
});
