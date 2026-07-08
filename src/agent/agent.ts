import {
  agent,
  type AgentOptions,
  type Message,
  type TextContent,
} from "@huuma/ai/agent";
import { openai } from "@huuma/ai/models/openai";
import { ollama } from "@huuma/ai/models/ollama";
import { anthropic } from "@huuma/ai/models/anthropic";
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
import { isHelpFlag } from "../command.ts";
import { choose, multiline, question } from "../input.ts";
import { CLEAR_LINE, dim, green, red, write } from "../terminal.ts";

/** The slice of the @huuma/ai agent the REPL drives. Derived from `agent`
 * with `Pick` so the `run` signature tracks @huuma/ai automatically, while
 * staying a plain object type that is trivial to fake in tests. */
export type Assistant = Pick<ReturnType<typeof agent>, "run">;

/** The agent's tool list, derived from @huuma/ai so it tracks the library
 * rather than re-declaring the element type by hand. */
type AgentTools = NonNullable<AgentOptions<string>["tools"]>;

const SYSTEM_PROMPT =
  "You are Huuma Agent, a helpful assistant running in a terminal. " +
  "Answer concisely in plain text without markdown formatting.";

export default async (args: string[] = []): Promise<string> => {
  let assistant: Assistant;
  let prompt: string;
  try {
    // A bad --tools flag or HUUMA_AGENT_PROVIDER is rendered like a turn error,
    // not a crash.
    const parsed = parseAgentArgs(args);
    if (parsed.help) return agentHelp();
    prompt = parsed.prompt;
    assistant = await setup(parsed.tools, parsed.systemPrompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${red("✖")} ${red(message)}\n`);
    Deno.exitCode = 1;
    return "";
  }
  return await chat(assistant, prompt);
};

/** Drives the agent: a single answer when `prompt` is non-empty (one-shot),
 * otherwise an interactive REPL until "exit"/"quit" or stdin closes. */
export async function chat(
  assistant: Assistant,
  prompt = "",
): Promise<string> {
  const oneShot = prompt.trim();
  if (oneShot) {
    // A single turn: respond() already printed the answer, so we keep only its
    // ok flag for the exit code and thread no history forward. If this ever
    // grows into chained prompts, carry the returned messages between turns
    // like the REPL below does.
    const { ok } = await respond(assistant, oneShot, []);
    if (!ok) Deno.exitCode = 1;
    return "";
  }

  console.log(dim('\nType "exit" to quit.\n'));

  let messages: Message[] = [];
  while (true) {
    let prompt: string;
    try {
      // Multi-line composer: Enter sends, Shift+Enter / Ctrl+J add a new line.
      prompt = await multiline("You:", {
        validate: (value) =>
          value ? undefined : 'Type a message or "exit" to quit',
      });
    } catch {
      // stdin closed while waiting for input (non-tty)
      break;
    }

    if (prompt === "exit" || prompt === "quit") break;
    messages = (await respond(assistant, prompt, messages)).messages;
  }

  return "Bye!";
}

/** Splits the agent's argv into the `--tools`/`--tool` selection and the
 * remaining prompt, or signals `--help`/`-h`. Flags must come before the
 * prompt; the first non-flag token (or a `--` terminator) begins the prompt, so
 * a one-shot prompt can contain dashes once it has started. */
export function parseAgentArgs(
  args: string[],
): {
  tools: string[];
  systemPrompt: string | undefined;
  prompt: string;
  help: boolean;
} {
  const tools: string[] = [];
  let systemPrompt: string | undefined;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (isHelpFlag(arg)) {
      return { tools: [], systemPrompt: undefined, prompt: "", help: true };
    }
    if (arg === "--") {
      i++;
      break;
    }
    if (arg === "--tools" || arg === "--tool") {
      const value = args[++i];
      if (value === undefined) {
        throw new Error(
          `Missing value for ${arg}. Example: ${arg} read_file,grep`,
        );
      }
      tools.push(...parseList(value));
      continue;
    }
    if (arg === "--system-prompt") {
      const value = args[++i];
      if (!value || value.trim() === "") {
        throw new Error(
          'Missing value for --system-prompt. Example: --system-prompt "Be a SQL expert."',
        );
      }
      systemPrompt = value;
      continue;
    }
    const inlineTools = inlineValue(arg);
    if (inlineTools !== undefined) {
      tools.push(...parseList(inlineTools));
      continue;
    }
    const inlineSystem = systemPromptInlineValue(arg);
    if (inlineSystem !== undefined) {
      if (inlineSystem.trim() === "") {
        throw new Error(
          'Missing value for --system-prompt. Example: --system-prompt "Be a SQL expert."',
        );
      }
      systemPrompt = inlineSystem;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(
        `Unknown flag "${arg}". The agent accepts --tools <list> and --system-prompt <text>.`,
      );
    }
    break;
  }
  return {
    tools,
    systemPrompt,
    prompt: args.slice(i).join(" ").trim(),
    help: false,
  };
}

/** Returns the value of a `--tools=`/`--tool=` token, or undefined otherwise. */
function inlineValue(arg: string): string | undefined {
  for (const prefix of ["--tools=", "--tool="]) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

/** Returns the value of a `--system-prompt=` token, or undefined otherwise. */
function systemPromptInlineValue(arg: string): string | undefined {
  const prefix = "--system-prompt=";
  if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  return undefined;
}

/** Usage text shown for `huuma agent --help`. The tool list is derived from
 * {@link TOOL_FACTORIES} so it can't drift from what `--tools` accepts. */
function agentHelp(): string {
  return `Chat with an AI agent in your terminal.

USAGE
  huuma agent [OPTIONS] [PROMPT]

  With a PROMPT the agent answers once and exits. Without one it starts an
  interactive session — type "exit" or "quit" to leave.

OPTIONS
  --tools <list>         Comma-separated tools to enable (default: none)
  --system-prompt <text> Replace the built-in system prompt for this run;
                         output style is then yours to manage
  -h, --help             Show this help

TOOLS
  ${Object.keys(TOOL_FACTORIES).join(", ")}
  ("files" is shorthand for every file tool)

ENVIRONMENT
  HUUMA_AGENT_PROVIDER       anthropic | openai | ollama
  HUUMA_AGENT_MODEL          model id (e.g. claude-haiku-4-5, gpt-4o-mini)
  HUUMA_AGENT_API_KEY        provider API key (omit for a local Ollama)
  HUUMA_AGENT_HOST           Ollama host (default http://localhost:11434)
  HUUMA_AGENT_CLI_COMMANDS   allow-list for the cli tool, e.g. "deno,git"
  HUUMA_AGENT_SEARCH_ENGINE  brave | perplexity

EXAMPLES
  huuma agent "What is the capital of France?"
  huuma agent --tools read_file,grep "What does src/mod.ts export?"
  huuma agent --system-prompt "Be a SQL expert, answer only in SQL." "select all users"`;
}

export async function setup(
  toolNames: string[] = [],
  systemPrompt?: string,
): Promise<Assistant> {
  // Built first so a bad tool name or config fails before any provider prompt.
  const tools = resolveTools(toolNames);
  // A supplied system prompt replaces the built-in for this run; absent falls
  // back to SYSTEM_PROMPT. See ADR 0005.
  const resolvedSystemPrompt = systemPrompt ?? SYSTEM_PROMPT;

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

    return agent({
      model: anthropic({ apiKey }),
      modelId,
      systemPrompt: resolvedSystemPrompt,
      tools,
    });
  }

  if (provider === "openai") {
    const apiKey = await resolveApiKey("OpenAI");
    const modelId = await resolveModel("gpt-4o-mini");

    return agent({
      model: openai({ apiKey }),
      modelId,
      systemPrompt: resolvedSystemPrompt,
      tools,
    });
  }

  if (provider === "ollama") {
    const host = envValue("HUUMA_AGENT_HOST") ??
      await question("Ollama host:", { default: "http://localhost:11434" });
    const apiKey = ollamaApiKey();
    const modelId = await resolveModel("llama3.2");

    return agent({
      model: ollama({ host, apiKey }),
      modelId,
      systemPrompt: resolvedSystemPrompt,
      tools,
    });
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

/** Builds the tools named on the `--tools` flag (see {@link TOOL_FACTORIES}).
 * An empty list means no tools, keeping the plain chat behavior. Tool-specific
 * configuration still comes from env vars (e.g. $HUUMA_AGENT_CLI_COMMANDS). An
 * unknown name throws, mirroring setup()'s strict handling of an unknown
 * provider. */
export function resolveTools(names: string[]): AgentTools {
  const tools: AgentTools = [];
  for (const name of names) {
    const build = TOOL_FACTORIES[name.toLowerCase()];
    if (!build) {
      throw new Error(
        `Unknown tool "${name}". Use --tools with a comma-separated list of: ` +
          `${Object.keys(TOOL_FACTORIES).join(", ")}.`,
      );
    }
    tools.push(...build());
  }
  return tools;
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

/** Splits a comma- or whitespace-separated env value into non-empty entries,
 * preserving case so command names stay exact. */
function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/[\s,]+/).filter(Boolean);
}

/** Reads a trimmed, non-empty env var when env permission is already granted;
 * returns undefined otherwise, without triggering a permission prompt. */
function envValue(variable: string): string | undefined {
  const { state } = Deno.permissions.querySync({ name: "env", variable });
  if (state !== "granted") return undefined;
  const value = Deno.env.get(variable)?.trim();
  return value ? value : undefined;
}

/** Outcome of a single turn: the conversation to carry forward — the new
 * messages when the model answered, the unchanged `history` when it failed so
 * a transient error doesn't wipe the chat — plus whether it answered. */
interface Turn {
  messages: Message[];
  ok: boolean;
}

export async function respond(
  assistant: Assistant,
  prompt: string,
  history: Message[],
): Promise<Turn> {
  write(dim("Thinking..."));
  try {
    const messages = await assistant.run(prompt, history);
    write(CLEAR_LINE);
    console.log(`${green("Agent:")} ${modelText(messages)}\n`);
    return { messages, ok: true };
  } catch (error) {
    write(CLEAR_LINE);
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${red("✖")} ${red(message)}\n`);
    return { messages: history, ok: false };
  }
}

/** Extracts the text of the last model message that contains any. */
export function modelText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "model") continue;

    const text = message.contents
      .filter((content): content is TextContent => "text" in content)
      .map((content) => content.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "(no response)";
}
