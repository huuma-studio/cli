import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import cliConfig from "../../deno.json" with { type: "json" };
import agentCommand from "./agent.ts";
import { quiet, withEnv } from "./testing.ts";

async function captureConsoleErrors<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; errors: string[] }> {
  const original = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  try {
    return { result: await fn(), errors };
  } finally {
    console.error = original;
  }
}

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

Deno.test("the agent command labels argument errors", async () => {
  const priorExitCode = Deno.exitCode;
  try {
    const { result, errors } = await captureConsoleErrors(() =>
      agentCommand(["--unknown-option"])
    );
    assertEquals(result, "");
    assertEquals(Deno.exitCode, 1);
    assertStringIncludes(errors.join("\n"), "[agent:arguments]");
  } finally {
    Deno.exitCode = priorExitCode;
  }
});

Deno.test("the agent command labels managed configuration errors", async () => {
  const priorExitCode = Deno.exitCode;
  try {
    const { result, errors } = await captureConsoleErrors(() =>
      agentCommand([
        "--callback-url",
        "https://callback.example.test/turns",
      ])
    );
    assertEquals(result, "");
    assertEquals(Deno.exitCode, 1);
    assertStringIncludes(errors.join("\n"), "[managed:config]");
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
  assertStringIncludes(result, "read_image");
  assertStringIncludes(result, "--cli-commands");
  assertStringIncludes(result, "--search-engine");
  assertStringIncludes(result, "--skills-path");
  assertStringIncludes(result, "--system-prompt");
  assertStringIncludes(result, "MANAGED TURN MODE");
  assertStringIncludes(result, "--callback-url");
  assertStringIncludes(result, "--history");
  assertStringIncludes(result, "--turn-deadline");
  assertStringIncludes(result, "cancelled 15 seconds before");
  assertStringIncludes(result, "limited to 100 model calls");
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

// ---------------------------------------------------------------------------
// --log-url (spec 111)
// ---------------------------------------------------------------------------

const LOG_RUN_ID = "11111111-1111-1111-1111-111111111111";

/** Managed args that fail config validation (no --history) after parsing. */
function configErrorArgs(logUrl?: string): string[] {
  return [
    "--callback-url",
    "https://callback.example.test/turns",
    "--run-id",
    LOG_RUN_ID,
    "--turn-id",
    "not-a-uuid",
    ...(logUrl === undefined ? [] : ["--log-url", logUrl]),
  ];
}

Deno.test("a managed config error is shipped to --log-url with stage config", async () => {
  const received: { body: Record<string, unknown>; type: string | null }[] = [];
  let delivered!: () => void;
  const arrived = new Promise<void>((resolve) => delivered = resolve);
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      received.push({
        body: await request.json(),
        type: request.headers.get("content-type"),
      });
      delivered();
      return new Response(null, { status: 202 });
    },
  );
  const priorExitCode = Deno.exitCode;
  try {
    const { errors } = await captureConsoleErrors(() =>
      agentCommand(
        configErrorArgs(
          `http://127.0.0.1:${server.addr.port}/functions/v1/logs`,
        ),
      )
    );
    assertEquals(Deno.exitCode, 1);
    assertStringIncludes(errors.join("\n"), "[managed:config]");
    await arrived;
    assertEquals(received.length, 1);
    const [{ body, type }] = received;
    assertEquals(type, "application/json");
    assertEquals(body.level, "error");
    assertEquals(body.source, "huuma-cli");
    assertEquals(body.source_version, cliConfig.version);
    assertEquals(body.scope, "managed");
    assertEquals(body.stage, "config");
    assertEquals(body.run_id, LOG_RUN_ID);
    // The invalid --turn-id is omitted without discarding the entry.
    assertEquals("turn_id" in body, false);
    assertEquals(body.context, { exit_code: 1 });
    assertStringIncludes(String(body.message), "--history is required");
  } finally {
    Deno.exitCode = priorExitCode;
    await server.shutdown();
  }
});

Deno.test("an invalid --log-url disables only logging and is never echoed", async () => {
  const priorExitCode = Deno.exitCode;
  try {
    const secretUrl = "https://user:hunter2@logs.example/?token=abc";
    const { result, errors } = await captureConsoleErrors(() =>
      agentCommand(configErrorArgs(secretUrl))
    );
    assertEquals(result, "");
    assertEquals(Deno.exitCode, 1);
    const output = errors.join("\n");
    assertStringIncludes(output, "diagnostic log shipping is disabled");
    assertStringIncludes(output, "[managed:config]");
    assertEquals(output.includes("hunter2"), false);
    assertEquals(output.includes("logs.example"), false);
  } finally {
    Deno.exitCode = priorExitCode;
  }
});

Deno.test("an unreachable --log-url does not change the outcome", async () => {
  // Reserve a port, then close it so connections are refused.
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const priorExitCode = Deno.exitCode;
  try {
    const baseline = await captureConsoleErrors(() =>
      agentCommand(configErrorArgs())
    );
    const baselineExit = Deno.exitCode;
    Deno.exitCode = 0;
    const withLog = await captureConsoleErrors(() =>
      agentCommand(configErrorArgs(`http://127.0.0.1:${port}/logs`))
    );
    assertEquals(Deno.exitCode, baselineExit);
    assertEquals(withLog.result, baseline.result);
    assertEquals(withLog.errors, baseline.errors);
    // Let the refused request settle inside this test.
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    Deno.exitCode = priorExitCode;
  }
});

Deno.test({
  name:
    "the real CLI process exits within the log request deadline against a hanging sink",
  // Spawns a Deno child process; allow for its startup separately from the
  // measured window, which starts when the sink accepts the connection.
  async fn() {
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = (listener.addr as Deno.NetAddr).port;
    const held: Deno.Conn[] = [];
    let acceptedAt: number | undefined;
    const accepting = (async () => {
      try {
        for await (const conn of listener) {
          // Never respond: the request can only end by the client's abort.
          acceptedAt ??= performance.now();
          held.push(conn);
        }
      } catch {
        // Listener closed.
      }
    })();
    try {
      const child = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-all",
          new URL("../mod.ts", import.meta.url).pathname,
          "agent",
          ...configErrorArgs(`http://127.0.0.1:${port}/logs`),
        ],
        stdout: "null",
        stderr: "piped",
      }).spawn();
      const status = await child.status;
      const exitedAt = performance.now();
      await child.stderr.cancel();
      assertEquals(status.code, 1);
      if (acceptedAt === undefined) {
        throw new Error("the log sink never received a connection");
      }
      const afterSendMs = exitedAt - acceptedAt;
      // Bounded by the 2 s request deadline plus scheduler tolerance, and not
      // shorter than most of it: the process really waited on the abort.
      assert(
        afterSendMs <= 2_000 + 750,
        `process exited ${afterSendMs.toFixed(0)} ms after the send`,
      );
      assert(
        afterSendMs >= 1_500,
        `process exited only ${afterSendMs.toFixed(0)} ms after the send`,
      );
    } finally {
      listener.close();
      for (const conn of held) conn.close();
      await accepting;
    }
  },
});
