import { agent } from "@huuma/ai/agent";
import { anthropic } from "@huuma/ai/models/anthropic";
import { ollama } from "@huuma/ai/models/ollama";
import { openai } from "@huuma/ai/models/openai";
import { google } from "@huuma/ai/models/google";
import { mistral } from "@huuma/ai/models/mistral";
import { choose, question } from "../input.ts";
import type { ModelSelection } from "./args.ts";
import type { Assistant } from "./chat.ts";
import { envValue } from "./env.ts";
import type { ManagedConfig } from "./managed/config.ts";
import type { SubagentContext } from "./subagents/mod.ts";
import { resolveSubagents, resolveTools, skillsTool } from "./tools.ts";

export const SYSTEM_PROMPT =
  "You are Huuma Agent, a helpful assistant running in a terminal. " +
  "Answer concisely in plain text without markdown formatting.";

/** Outcome of {@link resolveAgentTools}: the eager action tools, the preset
 * sub-agent names whose construction is deferred until a model exists, and
 * the always-on skills baseline (empty when `--tools` already lists `skills`,
 * so the agent gets one skills factory and one disk scan either way). */
export interface ResolvedAgentTools {
  tools: ReturnType<typeof resolveTools>["tools"];
  subagentNames: string[];
  skillsBaseline: ReturnType<typeof resolveTools>["tools"];
}

/** Resolves the `--tools` selection and the always-on skills baseline from a
 * run's options, ahead of provider/model resolution. Extracted from
 * {@link setup} so the "skills are on by default" behavior (ADR 0009) is
 * testable without a provider. Bad tool names or `cli`/`search` config throw
 * here, keeping the fail-early invariant. */
export function resolveAgentTools(options: SetupOptions): ResolvedAgentTools {
  const { cliCommands, searchEngine, skillsPath } = options;
  const { tools, subagentNames } = resolveTools(options.tools ?? [], {
    cliCommands,
    searchEngine,
    skillsPath,
  });
  // Skills are a baseline capability, on for every run. The pair is prepended to
  // the action tools unless `--tools` already listed `skills` — in which case
  // `resolveTools` built it with this run's `skillsPath`, so we avoid a second
  // factory and a second disk scan. The agent's Tools map dedupes by name.
  const skillsBaseline =
    options.tools?.some((t) => t.toLowerCase() === "skills")
      ? []
      : skillsTool(skillsPath);
  return { tools, subagentNames, skillsBaseline };
}

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
  /** Override for the skills directory scanned by the always-on skills
   * tools; absent means the CLI default `.agents/skills` (ADR 0009). */
  skillsPath?: string;
}

export async function setup(options: SetupOptions = {}): Promise<Assistant> {
  const { model } = options;
  // Resolve tools and the always-on skills baseline first so a bad tool name or
  // config fails before any provider prompt. Preset sub-agents need the
  // resolved model, so only their names are validated here and their
  // construction waits for a provider branch.
  const { tools, subagentNames, skillsBaseline } = resolveAgentTools(options);
  // A supplied system prompt replaces the built-in for this run; absent falls
  // back to SYSTEM_PROMPT. See ADR 0006.
  const resolvedSystemPrompt = options.systemPrompt ?? SYSTEM_PROMPT;

  // Shared tail of every provider branch: the sub-agent presets run on the
  // same model the parent agent is built with (ADR 0005). Skills go first so a
  // model that lists tools sees discovery before actions.
  const build = <T extends string>(ctx: SubagentContext<T>): Assistant =>
    agent({
      model: ctx.model,
      modelId: ctx.modelId,
      systemPrompt: resolvedSystemPrompt,
      tools: [
        ...skillsBaseline,
        ...tools,
        ...resolveSubagents(subagentNames, ctx),
      ],
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
        {
          label: "ollama",
          description: "Local or cloud models running via Ollama",
        },
        { label: "google", description: "Google Gemini API" },
        { label: "mistral", description: "Mistral API" },
      ],
      "Select a model provider:",
    );

  // Hosted-provider endpoints are fixed in code; only the ollama branch
  // reads --host. A supplied flag elsewhere is a mistake, and failing loud
  // beats silently ignoring it (ADR 0008).
  if (options.host !== undefined && provider !== "ollama") {
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
    const modelId = await resolveModel(model?.modelId, "glm-5.2:cloud");

    return build({ model: ollama({ host, apiKey }), modelId });
  }

  if (provider === "google") {
    const apiKey = await resolveApiKey("Google");
    const modelId = await resolveModel(model?.modelId, "gemini-2.5-flash");

    return build({ model: google({ apiKey }), modelId });
  }

  if (provider === "mistral") {
    const apiKey = await resolveApiKey("Mistral");
    const modelId = await resolveModel(model?.modelId, "mistral-small-latest");

    return build({ model: mistral({ apiKey }), modelId });
  }

  throw new Error(
    `Unknown provider "${provider}". Use --model <provider>/<model> with ` +
      "one of: anthropic, openai, google, mistral, ollama.",
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

/** Inputs to {@link buildManagedAgent}: the eager action tools, preset
 * sub-agent names (construction is deferred until the provider model exists),
 * the always-on skills baseline, and the resolved system prompt. Mirrors the
 * local {@link setup} build tail, but with `finishTurn: true` so the built-in
 * `finish_turn` control tool is registered (T1 / PLAN, "Execution flow"
 * step 3). Exported so tests can verify the `finishTurn` invariant with a
 * fake model, without constructing a real provider adapter. */
export interface ManagedAgentBuildOptions {
  tools: ReturnType<typeof resolveTools>["tools"];
  skillsBaseline: ReturnType<typeof resolveTools>["tools"];
  subagentNames: string[];
  systemPrompt: string;
}

/** Builds the managed-turn Agent from a resolved provider model and the
 * shared tool/skills/sub-agent composition. Identical to the local
 * {@link setup} build tail except for `finishTurn: true`: the managed runner
 * never registers a custom `finish_turn` tool — the built-in one is the only
 * outcome channel (PLAN, "Non-goals"). */
export function buildManagedAgent<T extends string>(
  ctx: SubagentContext<T>,
  options: ManagedAgentBuildOptions,
): Assistant {
  return agent({
    model: ctx.model,
    modelId: ctx.modelId,
    systemPrompt: options.systemPrompt,
    tools: [
      ...options.skillsBaseline,
      ...options.tools,
      ...resolveSubagents(options.subagentNames, ctx),
    ],
    finishTurn: true,
  });
}

/** The non-interactive counterpart of {@link setup} for managed turn mode.
 * Builds an Agent from a fully-validated {@link ManagedConfig} (T2) with no
 * stdin reads, no `choose`/`question` prompts, and no interactive fallbacks.
 *
 * Differences from {@link setup}:
 * - Enters `config.cwd` via `Deno.chdir` BEFORE `resolveAgentTools`, so the
 *   always-on skills tools' default `.agents/skills` and any relative
 *   `--skills-path` resolve inside the workspace (PLAN, "Related upstream
 *   work").
 * - Sets `finishTurn: true` on the agent (T1).
 * - Uses `config.model` directly (always present — `resolveManagedConfig`
 *   enforced it) and reads `HUUMA_AGENT_API_KEY` via `envValue` for hosted
 *   providers, re-checking defensively so a missing key fails fast with a
 *   clean message instead of a cryptic provider-SDK error.
 * - For ollama, uses `config.host` directly (always present) and treats
 *   `HUUMA_AGENT_API_KEY` as optional via `ollamaApiKey`.
 * - Enforces the existing `--host`-only-for-ollama rule and rejects unknown
 *   providers with the same errors as {@link setup}.
 *
 * `config.callbackSecret` is never read here — T3's callback reporter is the
 * sole consumer. */
// `async` matches the `setup()` signature and the spec's `Promise<Assistant>`
// return type; the body is synchronous today but stays async so future awaits
// (e.g. async tool resolution) can be added without breaking the contract.
// deno-lint-ignore require-await
export async function managedSetup(
  config: ManagedConfig,
): Promise<Assistant> {
  // Enter the workspace before tool setup so the default `.agents/skills`
  // and any relative `--skills-path` resolve inside it (PLAN, "Related
  // upstream work"). The caller (T5) is responsible for having already read
  // `--history` via `loadManagedInput` before this chdir.
  Deno.chdir(config.cwd);

  // Resolve tools and the always-on skills baseline first so a bad tool name
  // or config fails before any provider credential is read. Same fail-early
  // invariant as the local `setup`.
  const { tools, subagentNames, skillsBaseline } = resolveAgentTools(config);
  const resolvedSystemPrompt = config.systemPrompt ?? SYSTEM_PROMPT;

  const provider = config.model.provider;
  // Hosted-provider endpoints are fixed in code; only ollama reads --host.
  // `resolveManagedConfig` already enforced this, but the defensive check
  // keeps `managedSetup` honest if it is ever called without the resolver.
  if (config.host !== undefined && provider !== "ollama") {
    throw new Error("--host is only supported for the ollama provider.");
  }

  if (provider === "anthropic") {
    const apiKey = requiredManagedApiKey(provider);
    return buildManagedAgent(
      { model: anthropic({ apiKey }), modelId: config.model.modelId },
      {
        tools,
        skillsBaseline,
        subagentNames,
        systemPrompt: resolvedSystemPrompt,
      },
    );
  }

  if (provider === "openai") {
    const apiKey = requiredManagedApiKey(provider);
    return buildManagedAgent(
      { model: openai({ apiKey }), modelId: config.model.modelId },
      {
        tools,
        skillsBaseline,
        subagentNames,
        systemPrompt: resolvedSystemPrompt,
      },
    );
  }

  if (provider === "ollama") {
    // `resolveManagedConfig` enforced `--host` for ollama; `config.host` is
    // always present here. The API key is optional for unauthenticated hosts.
    const host = config.host!;
    const apiKey = ollamaApiKey();
    return buildManagedAgent(
      { model: ollama({ host, apiKey }), modelId: config.model.modelId },
      {
        tools,
        skillsBaseline,
        subagentNames,
        systemPrompt: resolvedSystemPrompt,
      },
    );
  }

  if (provider === "google") {
    const apiKey = requiredManagedApiKey(provider);
    return buildManagedAgent(
      { model: google({ apiKey }), modelId: config.model.modelId },
      {
        tools,
        skillsBaseline,
        subagentNames,
        systemPrompt: resolvedSystemPrompt,
      },
    );
  }

  if (provider === "mistral") {
    const apiKey = requiredManagedApiKey(provider);
    return buildManagedAgent(
      { model: mistral({ apiKey }), modelId: config.model.modelId },
      {
        tools,
        skillsBaseline,
        subagentNames,
        systemPrompt: resolvedSystemPrompt,
      },
    );
  }

  throw new Error(
    `Unknown provider "${provider}". Use --model <provider>/<model> with ` +
      "one of: anthropic, openai, google, mistral, ollama.",
  );
}

/** Reads `HUUMA_AGENT_API_KEY` for a hosted provider in managed turn mode and
 * fails fast with a clean, provider-named error when it is missing.
 * `resolveManagedConfig` already validated its presence, so this is a
 * defensive check — fail-fast beats a cryptic undefined-key error from the
 * provider SDK. */
function requiredManagedApiKey(provider: string): string {
  const apiKey = envValue("HUUMA_AGENT_API_KEY");
  if (!apiKey) {
    throw new Error(
      `HUUMA_AGENT_API_KEY is required in managed turn mode for the "${provider}" provider.`,
    );
  }
  return apiKey;
}
