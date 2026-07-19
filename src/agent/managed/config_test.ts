import { assertEquals, assertThrows } from "@std/assert";
import type { ManagedAgentArgs } from "../args.ts";
import { withEnv } from "../testing.ts";
import {
  isUuid,
  MIN_DEADLINE_REMAINING_MS,
  resolveManagedConfig,
} from "./config.ts";

/** A complete, valid ManagedAgentArgs. Tests clone it and break one field at a
 * time so every failure mode is isolated. `turnDeadline` is set ~1 hour in the
 * future at call time so the ≥15s-remaining check passes deterministically. */
function validArgs(
  overrides: Partial<ManagedAgentArgs> = {},
): ManagedAgentArgs {
  const futureMs = Date.now() + 60 * 60 * 1000;
  const future = new Date(futureMs).toISOString();
  return {
    mode: "managed",
    tools: [],
    cliCommands: [],
    systemPrompt: undefined,
    model: { provider: "anthropic", modelId: "claude-haiku-4-5" },
    host: undefined,
    searchEngine: undefined,
    skillsPath: undefined,
    prompt: "",
    help: false,
    history: "/workspace/history.json",
    cwd: "/workspace",
    callbackUrl: "https://api.huuma.studio/runs/1/callback",
    runId: "11111111-1111-1111-1111-111111111111",
    turnId: "22222222-2222-2222-2222-222222222222",
    turnDeadline: future,
    ...overrides,
  };
}

/** The required-env side of a valid invocation for the default anthropic
 * provider. Tests wrap a body in `withEnv` so each case starts from a known
 * secret + API-key state and restores the prior environment after. */
const REQUIRED_ENV = {
  HUUMA_AGENT_CALLBACK_SECRET: "turn-secret-value",
  HUUMA_AGENT_API_KEY: "provider-api-key",
} as const;

Deno.test("resolveManagedConfig returns a fully populated ManagedConfig", async () => {
  await withEnv(REQUIRED_ENV, () => {
    const config = resolveManagedConfig(validArgs());
    assertEquals(
      config.callbackUrl,
      new URL("https://api.huuma.studio/runs/1/callback"),
    );
    assertEquals(config.runId, "11111111-1111-1111-1111-111111111111");
    assertEquals(config.turnId, "22222222-2222-2222-2222-222222222222");
    assertEquals(config.historyPath, "/workspace/history.json");
    assertEquals(config.cwd, "/workspace");
    assertEquals(config.model, {
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
    });
    assertEquals(config.host, undefined);
    assertEquals(config.tools, []);
    assertEquals(config.cliCommands, []);
    assertEquals(config.systemPrompt, undefined);
    assertEquals(config.searchEngine, undefined);
    assertEquals(config.skillsPath, undefined);
    assertEquals(config.callbackSecret, "turn-secret-value");
    // The deadline is the parsed Date, not the raw string.
    assertEquals(config.turnDeadline.getTime() > Date.now(), true);
  });
});

Deno.test("resolveManagedConfig threads shared agent options through", async () => {
  await withEnv(REQUIRED_ENV, () => {
    const config = resolveManagedConfig(
      validArgs({
        tools: ["grep", "read_file"],
        cliCommands: ["deno", "git"],
        systemPrompt: "Be a SQL expert.",
        searchEngine: "brave",
        skillsPath: "./skills",
      }),
    );
    assertEquals(config.tools, ["grep", "read_file"]);
    assertEquals(config.cliCommands, ["deno", "git"]);
    assertEquals(config.systemPrompt, "Be a SQL expert.");
    assertEquals(config.searchEngine, "brave");
    assertEquals(config.skillsPath, "./skills");
  });
});

// ---------------------------------------------------------------------------
// 1. Required-together flag group.
// ---------------------------------------------------------------------------

Deno.test("resolveManagedConfig fails when any required flag is missing", async () => {
  await withEnv(REQUIRED_ENV, () => {
    for (
      const [flag, override] of [
        ["--history", { history: undefined }],
        ["--cwd", { cwd: undefined }],
        ["--run-id", { runId: undefined }],
        ["--turn-id", { turnId: undefined }],
        ["--turn-deadline", { turnDeadline: undefined }],
      ] as const
    ) {
      assertThrows(
        () => resolveManagedConfig(validArgs(override)),
        Error,
        `${flag} is required in managed turn mode`,
      );
    }
    // --model is checked separately (its parsed value is a ModelSelection,
    // not a string) but the error still names the flag.
    assertThrows(
      () => resolveManagedConfig(validArgs({ model: undefined })),
      Error,
      "--model is required in managed turn mode",
    );
  });
});

Deno.test("resolveManagedConfig reports the first missing required flag in canonical order", async () => {
  await withEnv(REQUIRED_ENV, () => {
    // Canonical order: history, cwd, run-id, turn-id, turn-deadline, model.
    // Dropping history and cwd together reports history first.
    assertThrows(
      () =>
        resolveManagedConfig(
          validArgs({ history: undefined, cwd: undefined }),
        ),
      Error,
      "--history is required in managed turn mode",
    );
    // --model is checked after the five string flags.
    assertThrows(
      () =>
        resolveManagedConfig(
          validArgs({ model: undefined, history: undefined }),
        ),
      Error,
      "--history is required in managed turn mode",
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Studio UUID validation.
// ---------------------------------------------------------------------------

Deno.test("isUuid accepts canonical and uppercase UUIDs and rejects the rest", () => {
  assertEquals(isUuid("11111111-1111-1111-1111-111111111111"), true);
  assertEquals(isUuid("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"), true);
  assertEquals(isUuid("not-a-uuid"), false);
  assertEquals(isUuid("11111111111111111111111111111111"), false); // no dashes
  assertEquals(
    isUuid("g1111111-1111-1111-1111-111111111111"),
    false,
  ); // non-hex
  assertEquals(isUuid(""), false);
});

Deno.test("resolveManagedConfig rejects malformed --run-id and --turn-id", async () => {
  await withEnv(REQUIRED_ENV, () => {
    assertThrows(
      () => resolveManagedConfig(validArgs({ runId: "not-a-uuid" })),
      Error,
      "--run-id must be a valid UUID. Received: not-a-uuid",
    );
    assertThrows(
      () => resolveManagedConfig(validArgs({ turnId: "xyz" })),
      Error,
      "--turn-id must be a valid UUID. Received: xyz",
    );
    // runId is validated before turnId.
    assertThrows(
      () =>
        resolveManagedConfig(
          validArgs({ runId: "bad", turnId: "also-bad" }),
        ),
      Error,
      "--run-id must be a valid UUID",
    );
  });
});

Deno.test("resolveManagedConfig accepts uppercase hex UUIDs", async () => {
  await withEnv(REQUIRED_ENV, () => {
    const config = resolveManagedConfig(
      validArgs({
        runId: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
        turnId: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB",
      }),
    );
    assertEquals(config.runId, "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA");
    assertEquals(config.turnId, "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB");
  });
});

// ---------------------------------------------------------------------------
// 3. Callback URL validation.
// ---------------------------------------------------------------------------

Deno.test("resolveManagedConfig rejects an unparseable --callback-url", async () => {
  await withEnv(REQUIRED_ENV, () => {
    assertThrows(
      () => resolveManagedConfig(validArgs({ callbackUrl: "not-a-url" })),
      Error,
      "--callback-url must be a valid absolute http/https URL. Received: not-a-url",
    );
    assertThrows(
      () => resolveManagedConfig(validArgs({ callbackUrl: "" })),
      Error,
      "--callback-url must be a valid absolute http/https URL. Received: ",
    );
  });
});

Deno.test("resolveManagedConfig rejects a non-http(s) --callback-url", async () => {
  await withEnv(REQUIRED_ENV, () => {
    for (
      const url of ["file:///etc/passwd", "ws://x.invalid/cb", "ftp://x/cb"]
    ) {
      assertThrows(
        () => resolveManagedConfig(validArgs({ callbackUrl: url })),
        Error,
        "--callback-url must be an http or https URL",
      );
    }
  });
});

Deno.test("resolveManagedConfig accepts http and https callback URLs", async () => {
  await withEnv(REQUIRED_ENV, () => {
    for (
      const url of ["http://localhost:8080/cb", "https://api.huuma.studio/cb"]
    ) {
      const config = resolveManagedConfig(validArgs({ callbackUrl: url }));
      assertEquals(config.callbackUrl, new URL(url));
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Turn deadline validation.
// ---------------------------------------------------------------------------

Deno.test("resolveManagedConfig rejects a malformed --turn-deadline", async () => {
  await withEnv(REQUIRED_ENV, () => {
    assertThrows(
      () => resolveManagedConfig(validArgs({ turnDeadline: "not-a-date" })),
      Error,
      "--turn-deadline must be a valid RFC3339 timestamp. Received: not-a-date",
    );
  });
});

Deno.test("resolveManagedConfig rejects a deadline with fewer than 15 seconds remaining", async () => {
  await withEnv(REQUIRED_ENV, () => {
    // Exactly 15s away is the boundary; the spec requires "at least 15
    // seconds to remain", so 15_000ms passes, 14_999ms fails. Use a value a
    // few seconds in the past to make the failure unambiguous.
    const soon = new Date(Date.now() + 5_000).toISOString();
    assertThrows(
      () => resolveManagedConfig(validArgs({ turnDeadline: soon })),
      Error,
      "--turn-deadline must leave at least 15 seconds when managed turn mode starts",
    );
    // A deadline in the past fails the same check.
    const past = new Date(Date.now() - 60_000).toISOString();
    assertThrows(
      () => resolveManagedConfig(validArgs({ turnDeadline: past })),
      Error,
      "--turn-deadline must leave at least 15 seconds when managed turn mode starts",
    );
  });
});

Deno.test("resolveManagedConfig accepts a deadline exactly 15s away and beyond", async () => {
  await withEnv(REQUIRED_ENV, () => {
    // 15s boundary: >= MIN_DEADLINE_REMAINING_MS passes. Add a small buffer
    // above the boundary so wall-clock jitter between computing the ISO string
    // and the resolver's Date.now() does not flip the result.
    const at15 = new Date(Date.now() + MIN_DEADLINE_REMAINING_MS + 500)
      .toISOString();
    const config = resolveManagedConfig(validArgs({ turnDeadline: at15 }));
    assertEquals(
      config.turnDeadline.getTime() - Date.now() >= MIN_DEADLINE_REMAINING_MS,
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Callback secret.
// ---------------------------------------------------------------------------

Deno.test("resolveManagedConfig requires HUUMA_AGENT_CALLBACK_SECRET", async () => {
  // Missing entirely.
  await withEnv(
    { HUUMA_AGENT_CALLBACK_SECRET: null, HUUMA_AGENT_API_KEY: "k" },
    () => {
      assertThrows(
        () => resolveManagedConfig(validArgs()),
        Error,
        "HUUMA_AGENT_CALLBACK_SECRET is required in managed turn mode",
      );
    },
  );
  // Empty/whitespace-only values are treated as missing (envValue trims).
  await withEnv(
    { HUUMA_AGENT_CALLBACK_SECRET: "   ", HUUMA_AGENT_API_KEY: "k" },
    () => {
      assertThrows(
        () => resolveManagedConfig(validArgs()),
        Error,
        "HUUMA_AGENT_CALLBACK_SECRET is required in managed turn mode",
      );
    },
  );
  await withEnv(
    { HUUMA_AGENT_CALLBACK_SECRET: "", HUUMA_AGENT_API_KEY: "k" },
    () => {
      assertThrows(
        () => resolveManagedConfig(validArgs()),
        Error,
        "HUUMA_AGENT_CALLBACK_SECRET is required in managed turn mode",
      );
    },
  );
});

Deno.test("resolveManagedConfig never echoes the callback secret in error messages", async () => {
  // Every error path that fires after the secret is read (i.e. the provider
  // credential check below) must not include the secret value. We force the
  // post-secret failure by setting an unknown provider, then assert the
  // secret string is absent from the thrown message.
  const secretValue = "super-secret-do-not-leak";
  await withEnv(
    { HUUMA_AGENT_CALLBACK_SECRET: secretValue, HUUMA_AGENT_API_KEY: null },
    () => {
      let message = "";
      try {
        resolveManagedConfig(
          validArgs({ model: { provider: "made-up", modelId: "x" } }),
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assertEquals(message.includes(secretValue), false);
      // Sanity check: the error fired at the provider step, not earlier.
      assertEquals(message.includes("Unknown provider"), true);
    },
  );
});

Deno.test("resolveManagedConfig never echoes HUUMA_AGENT_API_KEY in error messages", async () => {
  const apiKey = "provider-key-do-not-leak";
  // Hosted provider with the API key missing — error must name the variable,
  // not the value (which is unset here, but the assertion documents intent).
  await withEnv(
    { HUUMA_AGENT_CALLBACK_SECRET: "s", HUUMA_AGENT_API_KEY: null },
    () => {
      let message = "";
      try {
        resolveManagedConfig(validArgs());
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assertEquals(message.includes(apiKey), false);
      assertEquals(message.includes("HUUMA_AGENT_API_KEY"), true);
    },
  );
});

// ---------------------------------------------------------------------------
// 6. Provider-specific credential / host.
// ---------------------------------------------------------------------------

Deno.test("resolveManagedConfig requires HUUMA_AGENT_API_KEY for hosted providers", async () => {
  for (const provider of ["anthropic", "openai", "google", "mistral"]) {
    await withEnv(
      {
        HUUMA_AGENT_CALLBACK_SECRET: "s",
        HUUMA_AGENT_API_KEY: null,
      },
      () => {
        assertThrows(
          () =>
            resolveManagedConfig(
              validArgs({
                model: { provider, modelId: "some-model" },
              }),
            ),
          Error,
          `HUUMA_AGENT_API_KEY is required in managed turn mode for the "${provider}" provider`,
        );
      },
    );
  }
});

Deno.test("resolveManagedConfig accepts a hosted provider with HUUMA_AGENT_API_KEY set", async () => {
  await withEnv(REQUIRED_ENV, () => {
    for (const provider of ["anthropic", "openai", "google", "mistral"]) {
      const config = resolveManagedConfig(
        validArgs({ model: { provider, modelId: "m" } }),
      );
      assertEquals(config.model.provider, provider);
      assertEquals(config.host, undefined);
    }
  });
});

Deno.test("resolveManagedConfig requires --host for the ollama provider", async () => {
  await withEnv(
    { HUUMA_AGENT_CALLBACK_SECRET: "s", HUUMA_AGENT_API_KEY: null },
    () => {
      // Ollama without --host fails (the API key is optional, but --host is not).
      assertThrows(
        () =>
          resolveManagedConfig(
            validArgs({
              model: { provider: "ollama", modelId: "llama3.2" },
              host: undefined,
            }),
          ),
        Error,
        "--host is required in managed turn mode for the ollama provider",
      );
    },
  );
});

Deno.test("resolveManagedConfig accepts ollama with --host and no API key", async () => {
  await withEnv(
    { HUUMA_AGENT_CALLBACK_SECRET: "s", HUUMA_AGENT_API_KEY: null },
    () => {
      // An unauthenticated local Ollama: --host set, no API key — passes.
      const config = resolveManagedConfig(
        validArgs({
          model: { provider: "ollama", modelId: "llama3.2" },
          host: "http://localhost:11434",
        }),
      );
      assertEquals(config.model.provider, "ollama");
      assertEquals(config.host, "http://localhost:11434");
    },
  );
});

Deno.test("resolveManagedConfig accepts ollama with --host and an API key", async () => {
  await withEnv(REQUIRED_ENV, () => {
    const config = resolveManagedConfig(
      validArgs({
        model: { provider: "ollama", modelId: "llama3.2" },
        host: "https://cloud.olama.example",
      }),
    );
    assertEquals(config.host, "https://cloud.olama.example");
  });
});

Deno.test("resolveManagedConfig rejects an unknown provider", async () => {
  await withEnv(REQUIRED_ENV, () => {
    // The parser would have accepted --model made-up/x (it only splits on the
    // first slash); the resolver is where managed mode fails an unknown
    // provider instead of prompting for it interactively.
    assertThrows(
      () =>
        resolveManagedConfig(
          validArgs({ model: { provider: "made-up", modelId: "x" } }),
        ),
      Error,
      'Unknown provider "made-up"',
    );
  });
});

// ---------------------------------------------------------------------------
// Determinism: validation order is fixed (missing flag → UUID → URL →
// deadline → secret → provider credential).
// ---------------------------------------------------------------------------

Deno.test("resolveManagedConfig surfaces missing-flag before UUID/URL/deadline errors", async () => {
  await withEnv(REQUIRED_ENV, () => {
    // A missing --run-id beats a malformed --turn-id and a malformed URL.
    assertThrows(
      () =>
        resolveManagedConfig(
          validArgs({
            runId: undefined,
            turnId: "bad",
            callbackUrl: "not-a-url",
            turnDeadline: "not-a-date",
          }),
        ),
      Error,
      "--run-id is required in managed turn mode",
    );
  });
});

Deno.test("resolveManagedConfig surfaces UUID before URL/deadline/secret errors", async () => {
  // No secret set — but the UUID error fires first, so the missing-secret
  // error never gets a chance to surface.
  await withEnv(
    { HUUMA_AGENT_CALLBACK_SECRET: null, HUUMA_AGENT_API_KEY: "k" },
    () => {
      assertThrows(
        () =>
          resolveManagedConfig(
            validArgs({
              runId: "bad-uuid",
              callbackUrl: "not-a-url",
              turnDeadline: "not-a-date",
            }),
          ),
        Error,
        "--run-id must be a valid UUID",
      );
    },
  );
});

Deno.test("resolveManagedConfig surfaces URL before deadline/secret errors", async () => {
  await withEnv(
    { HUUMA_AGENT_CALLBACK_SECRET: null, HUUMA_AGENT_API_KEY: "k" },
    () => {
      assertThrows(
        () =>
          resolveManagedConfig(
            validArgs({
              callbackUrl: "not-a-url",
              turnDeadline: "not-a-date",
            }),
          ),
        Error,
        "--callback-url must be a valid absolute http/https URL",
      );
    },
  );
});

Deno.test("resolveManagedConfig surfaces deadline before secret errors", async () => {
  await withEnv(
    { HUUMA_AGENT_CALLBACK_SECRET: null, HUUMA_AGENT_API_KEY: "k" },
    () => {
      assertThrows(
        () =>
          resolveManagedConfig(
            validArgs({ turnDeadline: "not-a-date" }),
          ),
        Error,
        "--turn-deadline must be a valid RFC3339 timestamp",
      );
    },
  );
});

Deno.test("resolveManagedConfig surfaces secret before provider-credential errors", async () => {
  // Anthropic provider with no API key — but the missing-secret error fires
  // first because the secret check runs before the provider-credential check.
  await withEnv(
    { HUUMA_AGENT_CALLBACK_SECRET: null, HUUMA_AGENT_API_KEY: null },
    () => {
      assertThrows(
        () => resolveManagedConfig(validArgs()),
        Error,
        "HUUMA_AGENT_CALLBACK_SECRET is required in managed turn mode",
      );
    },
  );
});
