import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  ollamaApiKey,
  resolveAgentTools,
  resolveApiKey,
  resolveModel,
  setup,
} from "./setup.ts";
import { withEnv } from "./testing.ts";

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
