import { assertEquals, assertStringIncludes } from "@std/assert";
import type { Message } from "@huuma/ai/agent";
import {
  announceDelegation,
  SUBAGENT_FACTORIES,
  SUBAGENT_SUMMARIES,
} from "./mod.ts";

function modelReply(text: string): Message {
  return { role: "model", contents: [{ text }], toolCalls: [] };
}

Deno.test("the explorer preset builds exactly one tool", () => {
  const [tool, ...rest] = SUBAGENT_FACTORIES.explorer({
    model: {
      generate: () => Promise.reject(new Error("unused")),
      stream: () => Promise.reject(new Error("unused")),
    },
    modelId: "stub",
  });
  assertEquals(rest, []);
  assertEquals(tool.name, "explorer");
});

Deno.test("every preset has a help summary", () => {
  assertEquals(
    Object.keys(SUBAGENT_SUMMARIES),
    Object.keys(SUBAGENT_FACTORIES),
  );
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
