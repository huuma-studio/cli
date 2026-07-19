import { assertEquals, assertStringIncludes } from "@std/assert";
import agentCommand from "./agent.ts";
import { quiet, withEnv } from "./testing.ts";

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
  assertStringIncludes(result, "--skills-path");
  assertStringIncludes(result, "--system-prompt");
  assertStringIncludes(result, "MANAGED TURN MODE");
  assertStringIncludes(result, "--callback-url");
  assertStringIncludes(result, "--history");
  assertStringIncludes(result, "--turn-deadline");
});

Deno.test("the agent help states the skills tools are always enabled", async () => {
  const result = await quiet(() => agentCommand(["--help"]));
  assertStringIncludes(result, "skills");
  assertStringIncludes(result, "always enabled");
});

Deno.test("the agent help lists the explorer preset", async () => {
  const result = await quiet(() => agentCommand(["--help"]));
  assertStringIncludes(result, "SUBAGENTS");
  assertStringIncludes(result, "explorer");
});

Deno.test("managed arguments dispatch to managed configuration, not local chat", async () => {
  const priorExitCode = Deno.exitCode;
  try {
    await withEnv({ HUUMA_AGENT_CALLBACK_SECRET: "test-secret" }, async () => {
      const result = await quiet(() =>
        agentCommand([
          "--callback-url",
          "https://callback.example.test/turns",
          "--history",
          "history.json",
          "--cwd",
          ".",
          "--run-id",
          "11111111-1111-1111-1111-111111111111",
          "--turn-id",
          "22222222-2222-2222-2222-222222222222",
          "--turn-deadline",
          "2030-01-01T00:00:00Z",
          "--model",
          "unsupported/model",
        ])
      );
      // An unsupported provider is rejected by resolveManagedConfig before the
      // history is read or a local setup/chat path could start.
      assertEquals(result, "");
      assertEquals(Deno.exitCode, 1);
    });
  } finally {
    Deno.exitCode = priorExitCode;
  }
});

Deno.test("the agent command rejects managed-only flags without --callback-url", async () => {
  const priorExitCode = Deno.exitCode;
  try {
    const result = await quiet(() =>
      agentCommand(["--history", "history.json"])
    );
    assertEquals(result, "");
    assertEquals(Deno.exitCode, 1);
  } finally {
    Deno.exitCode = priorExitCode;
  }
});

Deno.test("the agent command rejects a positional prompt in managed mode", async () => {
  const priorExitCode = Deno.exitCode;
  try {
    const result = await quiet(() =>
      agentCommand([
        "--callback-url",
        "https://callback.example.test/turns",
        "not allowed here",
      ])
    );
    assertEquals(result, "");
    assertEquals(Deno.exitCode, 1);
  } finally {
    Deno.exitCode = priorExitCode;
  }
});
