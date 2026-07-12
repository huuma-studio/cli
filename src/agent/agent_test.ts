import { assertEquals, assertStringIncludes } from "@std/assert";
import agentCommand from "./agent.ts";
import { quiet } from "./testing.ts";

Deno.test("the agent command renders a setup failure instead of crashing", async () => {
  const priorExitCode = Deno.exitCode;
  try {
    const result = await quiet(() =>
      agentCommand(["--model", "gemini/gemini-pro", "hi"])
    );
    assertEquals(result, ""); // handled cleanly, not thrown
    assertEquals(Deno.exitCode, 1);
  } finally {
    Deno.exitCode = priorExitCode;
  }
});

Deno.test("the agent command renders an unknown --tools value as an error", async () => {
  const priorExitCode = Deno.exitCode;
  try {
    const result = await quiet(() =>
      agentCommand(["--tools", "browser", "hi"])
    );
    assertEquals(result, ""); // handled cleanly, not thrown
    assertEquals(Deno.exitCode, 1);
  } finally {
    Deno.exitCode = priorExitCode;
  }
});

Deno.test("the agent command returns help for --help without starting a chat", async () => {
  // Reaching setup() without a --model flag would block on the provider
  // prompt, so returning the usage text proves --help short-circuits first.
  const result = await quiet(() => agentCommand(["--help"]));
  assertStringIncludes(result, "huuma agent [OPTIONS] [PROMPT]");
  assertStringIncludes(result, "--model");
  assertStringIncludes(result, "google");
  assertStringIncludes(result, "mistral");
  assertStringIncludes(result, "--host");
  assertStringIncludes(result, "--tools");
  assertStringIncludes(result, "--cli-commands");
  assertStringIncludes(result, "--search-engine");
  assertStringIncludes(result, "--system-prompt");
});

Deno.test("the agent help lists the explorer preset", async () => {
  const result = await quiet(() => agentCommand(["--help"]));
  assertStringIncludes(result, "SUBAGENTS");
  assertStringIncludes(result, "explorer");
});
