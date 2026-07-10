import { agent } from "@huuma/ai/agent";
import { anthropic } from "@huuma/ai/models/anthropic";
import { ollama } from "@huuma/ai/models/ollama";
import { openai } from "@huuma/ai/models/openai";
import { choose, question } from "../input.ts";
import type { Assistant } from "./chat.ts";
import { envValue } from "./env.ts";
import type { SubagentContext } from "./subagents/mod.ts";
import { resolveSubagents, resolveTools } from "./tools.ts";

const SYSTEM_PROMPT =
  "You are Huuma Agent, a helpful assistant running in a terminal. " +
  "Answer concisely in plain text without markdown formatting.";

export async function setup(
  toolNames: string[] = [],
  systemPrompt?: string,
): Promise<Assistant> {
  // Resolved first so a bad tool name or config fails before any provider
  // prompt. Preset sub-agents need the resolved model, so only their names
  // are validated here and their construction waits for a provider branch.
  const { tools, subagentNames } = resolveTools(toolNames);
  // A supplied system prompt replaces the built-in for this run; absent falls
  // back to SYSTEM_PROMPT. See ADR 0006.
  const resolvedSystemPrompt = systemPrompt ?? SYSTEM_PROMPT;

  // Shared tail of every provider branch: the sub-agent presets run on the
  // same model the parent agent is built with (ADR 0005).
  const build = <T extends string>(ctx: SubagentContext<T>): Assistant =>
    agent({
      model: ctx.model,
      modelId: ctx.modelId,
      systemPrompt: resolvedSystemPrompt,
      tools: [...tools, ...resolveSubagents(subagentNames, ctx)],
    });

  const provider = envValue("HUUMA_AGENT_PROVIDER")?.toLowerCase() ??
    await choose(
      [
        { label: "anthropic", description: "Anthropic API" },
        { label: "openai", description: "OpenAI or any OpenAI-compatible API" },
        { label: "ollama", description: "Local models running via Ollama" },
      ],
      "Select a model provider:",
    );

  if (provider === "anthropic") {
    const apiKey = await resolveApiKey("Anthropic");
    const modelId = await resolveModel("claude-haiku-4-5");

    return build({ model: anthropic({ apiKey }), modelId });
  }

  if (provider === "openai") {
    const apiKey = await resolveApiKey("OpenAI");
    const modelId = await resolveModel("gpt-4o-mini");

    return build({ model: openai({ apiKey }), modelId });
  }

  if (provider === "ollama") {
    const host = envValue("HUUMA_AGENT_HOST") ??
      await question("Ollama host:", { default: "http://localhost:11434" });
    const apiKey = ollamaApiKey();
    const modelId = await resolveModel("llama3.2");

    return build({ model: ollama({ host, apiKey }), modelId });
  }

  throw new Error(
    `Unknown provider "${provider}". Set HUUMA_AGENT_PROVIDER to one of: ` +
      "anthropic, openai, ollama.",
  );
}

/** Model id from $HUUMA_AGENT_MODEL, otherwise an interactive prompt. */
export async function resolveModel(fallback: string): Promise<string> {
  return envValue("HUUMA_AGENT_MODEL") ??
    await question("Model:", { default: fallback });
}

/** Required API key from $HUUMA_AGENT_API_KEY, otherwise an interactive prompt.
 * Provider-specific vars like $OPENAI_API_KEY are intentionally not read, so a
 * key already in the environment for another tool can't silently be used. */
export async function resolveApiKey(label: string): Promise<string> {
  return envValue("HUUMA_AGENT_API_KEY") ??
    await question(`${label} API key:`, {
      validate: (value) => value ? undefined : "API key is required",
    });
}

/** Optional API key for Ollama Cloud / authenticated hosts, from
 * $HUUMA_AGENT_API_KEY. Undefined (and never prompted) for a local instance. */
export function ollamaApiKey(): string | undefined {
  return envValue("HUUMA_AGENT_API_KEY");
}
