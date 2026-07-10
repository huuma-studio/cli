import { assertEquals, assertRejects } from "@std/assert";
import { ollamaApiKey, resolveApiKey, resolveModel, setup } from "./setup.ts";
import { withEnv } from "./testing.ts";

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

Deno.test("setup rejects --host for non-ollama providers", async () => {
  for (const provider of ["anthropic", "openai"]) {
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
