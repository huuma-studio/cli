import { agent } from "@huuma/ai/agent";
import { anthropic } from "@huuma/ai/models/anthropic";
import { ollama } from "@huuma/ai/models/ollama";
import { openai } from "@huuma/ai/models/openai";
import { choose, question } from "../input.ts";
import type { ModelSelection } from "./args.ts";
import type { Assistant } from "./chat.ts";
import { envValue } from "./env.ts";
import type { SubagentContext } from "./subagents/mod.ts";
import { resolveSubagents, resolveTools } from "./tools.ts";

const SYSTEM_PROMPT =
  "You are Huuma Agent, a helpful assistant running in a terminal. " +
  "Answer concisely in plain text without markdown formatting.";

/** The agent's run configuration, a subset of the parsed argv (`AgentArgs`).
 * Everything here arrives via flags — never env vars — so a tooled agent
 * cannot rewrite it for future runs (ADR 0006, 0007, 0008). */
export interface SetupOptions {
  tools?: string[];
  systemPrompt?: string;
  model?: ModelSelection;
  cliCommands?: string[];
  host?: string;
  searchEngine?: string;
}

export async function setup(options: SetupOptions = {}): Promise<Assistant> {
  const { model, cliCommands, searchEngine } = options;
  // Resolved first so a bad tool name or config fails before any provider
  // prompt. Preset sub-agents need the resolved model, so only their names
  // are validated here and their construction waits for a provider branch.
  const { tools, subagentNames } = resolveTools(options.tools ?? [], {
    cliCommands,
    searchEngine,
  });
  // A supplied system prompt replaces the built-in for this run; absent falls
  // back to SYSTEM_PROMPT. See ADR 0006.
  const resolvedSystemPrompt = options.systemPrompt ?? SYSTEM_PROMPT;

  // Shared tail of every provider branch: the sub-agent presets run on the
  // same model the parent agent is built with (ADR 0005).
  const build = <T extends string>(ctx: SubagentContext<T>): Assistant =>
    agent({
      model: ctx.model,
      modelId: ctx.modelId,
      systemPrompt: resolvedSystemPrompt,
      tools: [...tools, ...resolveSubagents(subagentNames, ctx)],
    });

  // The provider and model come from the --model flag (argv is the one
  // channel a tooled agent cannot mutate mid-run — same argument as the
  // system prompt, ADR 0006), otherwise from interactive prompts. There is
  // deliberately no env var for either (ADR 0007).
  const provider = model?.provider ??
    await choose(
      [
        { label: "anthropic", description: "Anthropic API" },
        { label: "openai", description: "OpenAI or any OpenAI-compatible API" },
        { label: "ollama", description: "Local models running via Ollama" },
      ],
      "Select a model provider:",
    );

  // Anthropic and OpenAI endpoints are fixed in code; only the ollama branch
  // reads --host. A supplied flag elsewhere is a mistake, and failing loud
  // beats silently ignoring it (ADR 0008).
  if (
    options.host !== undefined &&
    (provider === "anthropic" || provider === "openai")
  ) {
    throw new Error("--host is only supported for the ollama provider.");
  }

  if (provider === "anthropic") {
    const apiKey = await resolveApiKey("Anthropic");
    const modelId = await resolveModel(model?.modelId, "claude-haiku-4-5");

    return build({ model: anthropic({ apiKey }), modelId });
  }

  if (provider === "openai") {
    const apiKey = await resolveApiKey("OpenAI");
    const modelId = await resolveModel(model?.modelId, "gpt-4o-mini");

    return build({ model: openai({ apiKey }), modelId });
  }

  if (provider === "ollama") {
    const host = options.host ??
      await question("Ollama host:", { default: "http://localhost:11434" });
    const apiKey = ollamaApiKey();
    const modelId = await resolveModel(model?.modelId, "llama3.2");

    return build({ model: ollama({ host, apiKey }), modelId });
  }

  throw new Error(
    `Unknown provider "${provider}". Use --model <provider>/<model> with ` +
      "one of: anthropic, openai, ollama.",
  );
}

/** Model id from the --model flag, otherwise an interactive prompt. */
export async function resolveModel(
  selected: string | undefined,
  fallback: string,
): Promise<string> {
  return selected ?? await question("Model:", { default: fallback });
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
