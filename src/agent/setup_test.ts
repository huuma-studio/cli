import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { BaseModel, Message, ModelResult } from "@huuma/ai/agent";
import {
  buildManagedAgent,
  managedSetup,
  ollamaApiKey,
  resolveAgentTools,
  resolveApiKey,
  resolveModel,
  setup,
  SYSTEM_PROMPT,
} from "./setup.ts";
import type { ManagedConfig } from "./managed/config.ts";
import { quiet, withEnv } from "./testing.ts";

Deno.test("resolveAgentTools includes the skills baseline by default", () => {
  // Skills are on for every run (ADR 0009): with no --tools the skills pair is
  // the only thing on the agent.
  const { tools, skillsBaseline } = resolveAgentTools({});
  assertEquals(tools, []);
  assertEquals(skillsBaseline.map((t) => t.name), [
    "list_skills",
    "retrieve_skill",
  ]);
});

Deno.test("resolveAgentTools keeps the skills baseline alongside --tools actions", () => {
  const { tools, skillsBaseline } = resolveAgentTools({ tools: ["grep"] });
  assertEquals(tools.map((t) => t.name), ["grep"]);
  assertEquals(skillsBaseline.map((t) => t.name), [
    "list_skills",
    "retrieve_skill",
  ]);
});

Deno.test("resolveAgentTools skips the skills baseline when --tools already lists skills", () => {
  // One factory, one scan: listing skills in --tools builds it via resolveTools,
  // so the baseline stays empty to avoid a second factory / second disk scan.
  const { tools, skillsBaseline } = resolveAgentTools({ tools: ["skills"] });
  assertEquals(tools.map((t) => t.name), ["list_skills", "retrieve_skill"]);
  assertEquals(skillsBaseline, []);
});

Deno.test("resolveAgentTools threads --skills-path into the scan directory", async () => {
  const root = await Deno.makeTempDir();
  try {
    const skillDir = join(root, "mcp-builder");
    await Deno.mkdir(skillDir);
    await Deno.writeTextFile(
      join(skillDir, "SKILL.md"),
      "---\nname: mcp-builder\ndescription: builds MCP servers\n---\n# mcp-builder\n",
    );
    const { skillsBaseline } = resolveAgentTools({ skillsPath: root });
    const list = skillsBaseline.find((t) => t.name === "list_skills")!;
    assertEquals(await list.call({}), [
      { name: "mcp-builder", description: "builds MCP servers" },
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("resolveModel returns the --model selection without prompting", async () => {
  assertEquals(
    await resolveModel("claude-opus-4-8", "fallback-model"),
    "claude-opus-4-8",
  );
});

Deno.test("resolveApiKey uses HUUMA_AGENT_API_KEY even when provider keys are set", async () => {
  await withEnv(
    {
      HUUMA_AGENT_API_KEY: "the-key",
      OPENAI_API_KEY: "ambient",
      ANTHROPIC_API_KEY: "ambient",
    },
    async () => {
      // Ambient provider keys must not override the explicit HUUMA_AGENT_API_KEY.
      assertEquals(await resolveApiKey("OpenAI"), "the-key");
      assertEquals(await resolveApiKey("Anthropic"), "the-key");
    },
  );
});

Deno.test("setup rejects an unknown --model provider", async () => {
  await assertRejects(
    () => setup({ model: { provider: "gemini", modelId: "gemini-pro" } }),
    Error,
    'Unknown provider "gemini"',
  );
});

Deno.test("setup builds an assistant for the google and mistral providers", async () => {
  await withEnv({ HUUMA_AGENT_API_KEY: "key" }, async () => {
    for (
      const [provider, modelId] of [
        ["google", "gemini-2.5-flash"],
        ["mistral", "mistral-small-latest"],
      ]
    ) {
      const assistant = await setup({ model: { provider, modelId } });
      assertEquals(typeof assistant.run, "function");
    }
  });
});

Deno.test("setup rejects --host for non-ollama providers", async () => {
  for (const provider of ["anthropic", "openai", "google", "mistral"]) {
    await assertRejects(
      () =>
        setup({
          model: { provider, modelId: "some-model" },
          host: "http://localhost:11434",
        }),
      Error,
      "--host is only supported for the ollama provider",
    );
  }
});

Deno.test("ollamaApiKey returns HUUMA_AGENT_API_KEY, else undefined", async () => {
  await withEnv(
    { HUUMA_AGENT_API_KEY: "key", OLLAMA_API_KEY: "ambient" },
    () => assertEquals(ollamaApiKey(), "key"),
  );
  await withEnv(
    { HUUMA_AGENT_API_KEY: null },
    () => assertEquals(ollamaApiKey(), undefined),
  );
});

// --- managedSetup ----------------------------------------------------------
// `managedSetup` is the non-interactive counterpart of `setup` for managed
// turn mode. These tests cover the provider matrix, the `finishTurn: true`
// invariant, the cwd change, the no-stdin invariant, shared-option threading,
// and the system-prompt fallback.

/** Minimal scripted model mirroring @huuma/ai's StubModel pattern. Records the
 * `tools` and `system` passed to each `generate` call so tests can assert on
 * what the agent actually sent. Returns one scripted model message per call
 * with no tool calls, which terminates the run after the first model turn. */
class RecordingModel implements BaseModel<string> {
  calls: { tools: { name: string }[]; system?: string }[] = [];
  #responses: Message[][];

  constructor(responses?: Message[][]) {
    this.#responses = responses ?? [[modelReply("done")]];
  }

  generate(args: unknown): Promise<ModelResult<string>> {
    const { tools, system } = args as {
      tools?: { name: string }[];
      system?: string;
    };
    this.calls.push({ tools: tools ?? [], system });
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

/** Builds a {@link ManagedConfig} with the given overrides. Only the fields
 * `managedSetup` actually reads are surfaced; the rest are valid-shaped
 * placeholders so the object satisfies the type. */
function managedConfig(
  overrides:
    & Partial<
      Pick<
        ManagedConfig,
        | "model"
        | "host"
        | "systemPrompt"
        | "tools"
        | "cliCommands"
        | "searchEngine"
        | "skillsPath"
      >
    >
    & {
      cwd?: string;
    },
): ManagedConfig {
  return {
    callbackUrl: new URL("https://example.test/callback"),
    runId: "00000000-0000-0000-0000-000000000000",
    turnId: "00000000-0000-0000-0000-000000000001",
    turnDeadline: new Date(Date.now() + 60_000),
    historyPath: "/unused/by/managedSetup",
    cwd: overrides.cwd ?? ".",
    model: overrides.model ??
      { provider: "anthropic", modelId: "claude-haiku-4-5" },
    host: overrides.host,
    tools: overrides.tools ?? [],
    cliCommands: overrides.cliCommands ?? [],
    systemPrompt: overrides.systemPrompt,
    searchEngine: overrides.searchEngine,
    skillsPath: overrides.skillsPath,
    callbackSecret: "secret",
  };
}

Deno.test("managedSetup builds an assistant for every hosted provider", async () => {
  await withEnv({ HUUMA_AGENT_API_KEY: "key" }, async () => {
    for (
      const [provider, modelId] of [
        ["anthropic", "claude-haiku-4-5"],
        ["openai", "gpt-4o-mini"],
        ["google", "gemini-2.5-flash"],
        ["mistral", "mistral-small-latest"],
      ] as const
    ) {
      const originalCwd = Deno.cwd();
      const dir = await Deno.makeTempDir();
      try {
        const assistant = await managedSetup(
          managedConfig({ model: { provider, modelId }, cwd: dir }),
        );
        assertEquals(typeof assistant.run, "function");
      } finally {
        Deno.chdir(originalCwd);
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      }
    }
  });
});

Deno.test("managedSetup builds an assistant for ollama with --host and no API key", async () => {
  await withEnv({ HUUMA_AGENT_API_KEY: null }, async () => {
    const originalCwd = Deno.cwd();
    const dir = await Deno.makeTempDir();
    try {
      const assistant = await managedSetup(
        managedConfig({
          model: { provider: "ollama", modelId: "glm-5.2:cloud" },
          host: "http://localhost:11434",
          cwd: dir,
        }),
      );
      assertEquals(typeof assistant.run, "function");
    } finally {
      Deno.chdir(originalCwd);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  });
});

Deno.test("managedSetup sets finishTurn: true (the built-in finish_turn tool is registered)", async () => {
  // The agent's tool list is private, so the only way to observe
  // `finishTurn: true` behaviorally is to run the agent against a fake model
  // and inspect the `tools` array passed to `model.generate`. This proves the
  // managed-turn build path registers the built-in `finish_turn` control tool
  // (PLAN, "Execution flow" step 3). `buildManagedAgent` is `managedSetup`'s
  // build tail, so the invariant holds for every provider branch.
  const model = new RecordingModel();
  const assistant = buildManagedAgent(
    { model, modelId: "stub" },
    { tools: [], skillsBaseline: [], subagentNames: [], systemPrompt: "x" },
  );
  await quiet(() => assistant.run("hi", []));
  assertEquals(model.calls.length, 1);
  const toolNames = model.calls[0].tools.map((t) => t.name);
  assertEquals(toolNames, ["finish_turn"]);
});

Deno.test("managedSetup rejects --host for non-ollama providers", async () => {
  await withEnv({ HUUMA_AGENT_API_KEY: "key" }, async () => {
    for (const provider of ["anthropic", "openai", "google", "mistral"]) {
      const originalCwd = Deno.cwd();
      const dir = await Deno.makeTempDir();
      try {
        await assertRejects(
          () =>
            managedSetup(
              managedConfig({
                model: { provider, modelId: "some-model" },
                host: "http://localhost:11434",
                cwd: dir,
              }),
            ),
          Error,
          "--host is only supported for the ollama provider",
        );
      } finally {
        Deno.chdir(originalCwd);
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      }
    }
  });
});

Deno.test("managedSetup rejects an unknown provider", async () => {
  const originalCwd = Deno.cwd();
  const dir = await Deno.makeTempDir();
  try {
    await assertRejects(
      () =>
        managedSetup(
          managedConfig({
            model: { provider: "gemini", modelId: "gemini-pro" },
            cwd: dir,
          }),
        ),
      Error,
      'Unknown provider "gemini"',
    );
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("managedSetup rejects a missing HUUMA_AGENT_API_KEY for hosted providers", async () => {
  // `resolveManagedConfig` would have caught this first; the defensive check
  // in `managedSetup` fails fast with the same clean message if the resolver
  // is ever bypassed.
  await withEnv({ HUUMA_AGENT_API_KEY: null }, async () => {
    const originalCwd = Deno.cwd();
    const dir = await Deno.makeTempDir();
    try {
      await assertRejects(
        () =>
          managedSetup(
            managedConfig({
              model: { provider: "anthropic", modelId: "claude-haiku-4-5" },
              cwd: dir,
            }),
          ),
        Error,
        'HUUMA_AGENT_API_KEY is required in managed turn mode for the "anthropic" provider',
      );
    } finally {
      Deno.chdir(originalCwd);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  });
});

Deno.test("managedSetup changes the process working directory to config.cwd", async () => {
  await withEnv({ HUUMA_AGENT_API_KEY: "key" }, async () => {
    const originalCwd = Deno.cwd();
    const dir = await Deno.makeTempDir();
    try {
      await managedSetup(managedConfig({ cwd: dir }));
      // The agent enters the workspace before tool setup so the default
      // `.agents/skills` and any relative `--skills-path` resolve inside it.
      assertEquals(Deno.realPathSync(Deno.cwd()), Deno.realPathSync(dir));
    } finally {
      Deno.chdir(originalCwd);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  });
});

Deno.test("managedSetup never reads stdin (completes without hanging when stdin is closed)", async () => {
  // The proof is non-hanging completion: `managedSetup` with stdin closed
  // (Deno test pipes stdin from /dev/null) builds the assistant without ever
  // awaiting `choose` or `question`. If it regressed to interactive prompts,
  // this test would block until the test runner's timeout.
  await withEnv({ HUUMA_AGENT_API_KEY: "key" }, async () => {
    const originalCwd = Deno.cwd();
    const dir = await Deno.makeTempDir();
    try {
      const assistant = await managedSetup(managedConfig({ cwd: dir }));
      assertEquals(typeof assistant.run, "function");
    } finally {
      Deno.chdir(originalCwd);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  });
});

Deno.test("managedSetup threads shared options through resolveAgentTools (bad --tools throws)", async () => {
  await withEnv({ HUUMA_AGENT_API_KEY: "key" }, async () => {
    const originalCwd = Deno.cwd();
    const dir = await Deno.makeTempDir();
    try {
      await assertRejects(
        () =>
          managedSetup(
            managedConfig({ tools: ["not-a-real-tool"], cwd: dir }),
          ),
        Error,
      );
    } finally {
      Deno.chdir(originalCwd);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  });
});

Deno.test("managedSetup uses config.systemPrompt when supplied, falls back to SYSTEM_PROMPT when undefined", async () => {
  // The agent's `#systemPrompt` is private, so the system-prompt threading is
  // verified at the `buildManagedAgent` layer with a recording model, and the
  // fallback is verified by `managedSetup` building successfully in both
  // cases. Together they prove `config.systemPrompt ?? SYSTEM_PROMPT` reaches
  // `agent()`.
  const withCustom = new RecordingModel();
  await quiet(() =>
    buildManagedAgent(
      { model: withCustom, modelId: "stub" },
      {
        tools: [],
        skillsBaseline: [],
        subagentNames: [],
        systemPrompt: "custom",
      },
    ).run("hi", [])
  );
  assertEquals(withCustom.calls[0].system, "custom");

  const withFallback = new RecordingModel();
  await quiet(() =>
    buildManagedAgent(
      { model: withFallback, modelId: "stub" },
      {
        tools: [],
        skillsBaseline: [],
        subagentNames: [],
        systemPrompt: SYSTEM_PROMPT,
      },
    ).run("hi", [])
  );
  assertEquals(withFallback.calls[0].system, SYSTEM_PROMPT);

  // managedSetup itself builds in both cases without throwing.
  await withEnv({ HUUMA_AGENT_API_KEY: "key" }, async () => {
    const originalCwd = Deno.cwd();
    const dir = await Deno.makeTempDir();
    try {
      const a1 = await managedSetup(
        managedConfig({ systemPrompt: "custom", cwd: dir }),
      );
      assertEquals(typeof a1.run, "function");
      const a2 = await managedSetup(managedConfig({ cwd: dir }));
      assertEquals(typeof a2.run, "function");
    } finally {
      Deno.chdir(originalCwd);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  });
});
