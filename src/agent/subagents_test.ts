import { assertEquals, assertStringIncludes } from "@std/assert";
import type { BaseModel, Message, ModelResult } from "@huuma/ai/agent";
import {
  announceDelegation,
  SUBAGENT_FACTORIES,
  SUBAGENT_SUMMARIES,
} from "./subagents.ts";

/** Minimal scripted model, mirroring @huuma/ai's own StubModel pattern. */
class StubModel implements BaseModel<string> {
  calls: { messages: Message[]; system?: string }[] = [];
  #responses: Message[][];

  constructor(responses: Message[][]) {
    this.#responses = responses;
  }

  generate(args: unknown): Promise<ModelResult<string>> {
    const { messages, system } = args as {
      messages: Message[];
      system?: string;
    };
    this.calls.push({ messages, system });
    const response = this.#responses.shift();
    if (!response) {
      return Promise.reject(new Error("No scripted response left"));
    }
    return Promise.resolve({ modelId: "stub", messages: response });
  }

  stream(): Promise<AsyncGenerator<ModelResult>> {
    return Promise.reject(new Error("Not implemented"));
  }
}

function modelReply(text: string): Message {
  return { role: "model", contents: [{ text }], toolCalls: [] };
}

/** Runs `fn` with terminal output suppressed so the delegation status line
 * stays out of the test report. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const { log } = console;
  const writeSync = Deno.stdout.writeSync.bind(Deno.stdout);
  console.log = () => {};
  Deno.stdout.writeSync = () => 0;
  try {
    return await fn();
  } finally {
    console.log = log;
    Deno.stdout.writeSync = writeSync;
  }
}

Deno.test("the explorer factory builds one tool that demands self-contained prompts", () => {
  const [tool, ...rest] = SUBAGENT_FACTORIES.explorer({
    model: new StubModel([]),
    modelId: "stub",
  });
  assertEquals(rest, []);
  assertEquals(tool.name, "explorer");
  assertStringIncludes(tool.description, "self-contained");
});

Deno.test("every preset has a help summary", () => {
  assertEquals(
    Object.keys(SUBAGENT_SUMMARIES),
    Object.keys(SUBAGENT_FACTORIES),
  );
});

Deno.test("delegation runs the sub-agent and returns its final text", async () => {
  const model = new StubModel([[modelReply("Findings.")]]);
  const [tool] = SUBAGENT_FACTORIES.explorer({ model, modelId: "stub" });

  const result = await quiet(() => tool.call({ prompt: "inspect src/mod.ts" }));

  assertEquals(result, "Findings.");
  // The delegation prompt arrives as the sub-agent's own fresh conversation.
  assertEquals(model.calls[0].messages, [
    { role: "user", contents: "inspect src/mod.ts" },
  ]);
  assertStringIncludes(model.calls[0].system ?? "", "Explorer");
});

Deno.test("announceDelegation prints one dim line per delegation", async () => {
  const lines: string[] = [];
  const { log } = console;
  const writeSync = Deno.stdout.writeSync.bind(Deno.stdout);
  console.log = (line: string) => {
    lines.push(line);
  };
  Deno.stdout.writeSync = () => 0;
  try {
    const announce = announceDelegation("explorer");
    await announce({ role: "user", contents: "inspect   src/mod.ts\nexports" });
    await announce(modelReply("on it"));
    await announce({
      role: "user",
      contents: `${"x".repeat(100)}`,
    });
  } finally {
    console.log = log;
    Deno.stdout.writeSync = writeSync;
  }

  // Only the two user messages announce; the model message stays silent.
  assertEquals(lines.length, 2);
  assertStringIncludes(lines[0], "explorer ← inspect src/mod.ts exports");
  // Long prompts are truncated to one terminal-friendly line.
  assertStringIncludes(lines[1], "…");
});
