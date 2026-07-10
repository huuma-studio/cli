import type { AgentOptions } from "@huuma/ai/agent";
import {
  cli,
  createDirectory,
  deleteFile,
  editFile,
  fetchWebsite,
  files,
  grep,
  readFile,
  search,
  writeFile,
} from "@huuma/ai/tools";
import { envValue, parseList } from "./env.ts";
import { SUBAGENT_FACTORIES, type SubagentContext } from "./subagents/mod.ts";

/** The agent's tool list, derived from @huuma/ai so it tracks the library
 * rather than re-declaring the element type by hand. */
export type AgentTools = NonNullable<AgentOptions<string>["tools"]>;

/** Tool factories keyed by the name used on the `--tools` flag. Each one builds
 * its tools lazily so nothing is constructed unless requested — `cli` and
 * `search` validate their own config and would otherwise throw. `files` is
 * shorthand for the whole file-system set; every other key is the tool name
 * the model sees. */
const TOOL_FACTORIES: Record<string, () => AgentTools> = {
  cli: () => [cliTool()],
  grep: () => [grep()],
  read_file: () => [readFile()],
  write_file: () => [writeFile()],
  create_directory: () => [createDirectory()],
  delete_file: () => [deleteFile()],
  edit_file: () => [editFile()],
  files: () => files(),
  fetch_website: () => [fetchWebsite()],
  search: () => [searchTool()],
};

/** Outcome of resolving the `--tools` selection: the tools built eagerly,
 * plus the preset sub-agent names whose construction is deferred until the
 * provider/model is resolved (see {@link SUBAGENT_FACTORIES}). */
export interface ResolvedTools {
  tools: AgentTools;
  subagentNames: string[];
}

/** Every name `--tools` accepts: regular tools and preset sub-agents. Both
 * the help text and the unknown-name error derive from this so they can't
 * drift from what {@link resolveTools} resolves. */
export function allToolNames(): string[] {
  return [...Object.keys(TOOL_FACTORIES), ...Object.keys(SUBAGENT_FACTORIES)];
}

/** Builds the tools named on the `--tools` flag (see {@link TOOL_FACTORIES}).
 * An empty list means no tools, keeping the plain chat behavior. Tool-specific
 * configuration still comes from env vars (e.g. $HUUMA_AGENT_CLI_COMMANDS). An
 * unknown name throws, mirroring setup()'s strict handling of an unknown
 * provider. Preset sub-agent names are validated here but built later by
 * {@link resolveSubagents}, once a model exists to run them on. */
export function resolveTools(names: string[]): ResolvedTools {
  const tools: AgentTools = [];
  const subagentNames: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    const build = TOOL_FACTORIES[key];
    if (build) {
      tools.push(...build());
      continue;
    }
    if (SUBAGENT_FACTORIES[key]) {
      // Deduped: the agent keeps tools in a name-keyed map, so a repeated
      // preset would only construct a sub-agent that gets replaced anyway.
      if (!subagentNames.includes(key)) subagentNames.push(key);
      continue;
    }
    throw new Error(
      `Unknown tool "${name}". Use --tools with a comma-separated list of: ` +
        `${allToolNames().join(", ")}.`,
    );
  }
  return { tools, subagentNames };
}

/** Builds the preset sub-agent tools deferred by {@link resolveTools}. Names
 * are already validated there, so this only constructs. */
export function resolveSubagents<T extends string>(
  names: string[],
  ctx: SubagentContext<T>,
): AgentTools {
  return names.flatMap((name) => SUBAGENT_FACTORIES[name](ctx));
}

/** The `cli` tool, limited to the allow-list in $HUUMA_AGENT_CLI_COMMANDS.
 * Without it the tool would expose no runnable commands, so we fail with a
 * hint instead of registering a dead tool. */
function cliTool(): AgentTools[number] {
  const allowedCommands = parseList(envValue("HUUMA_AGENT_CLI_COMMANDS"));
  if (allowedCommands.length === 0) {
    throw new Error(
      "The cli tool needs an allow-list. Set HUUMA_AGENT_CLI_COMMANDS to a " +
        'comma-separated list of commands (e.g. "deno,git").',
    );
  }
  return cli({ allowedCommands });
}

/** The `search` tool. The engine is required via $HUUMA_AGENT_SEARCH_ENGINE so
 * the choice is explicit; the provider reads its key from $BRAVE_API_KEY or
 * $PERPLEXITY_API_KEY when the tool runs. */
function searchTool(): AgentTools[number] {
  const engine = envValue("HUUMA_AGENT_SEARCH_ENGINE")?.toLowerCase();
  if (engine !== "brave" && engine !== "perplexity") {
    throw new Error(
      "The search tool needs an engine. Set HUUMA_AGENT_SEARCH_ENGINE to " +
        '"brave" or "perplexity".',
    );
  }
  return search({ engine });
}
