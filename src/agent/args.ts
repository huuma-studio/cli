import { isHelpFlag } from "../command.ts";
import { parseList } from "./env.ts";

/** The provider and model a `--model provider/model` flag selects. The
 * provider is normalized to lowercase; the model id keeps its case. */
export interface ModelSelection {
  provider: string;
  modelId: string;
}

/** The agent's parsed argv. Behavioral configuration lives in flags, never
 * env vars, so a tooled agent cannot rewrite it for future runs (ADR 0007,
 * ADR 0008); only secrets stay in the environment. */
export interface AgentArgs {
  tools: string[];
  cliCommands: string[];
  systemPrompt: string | undefined;
  model: ModelSelection | undefined;
  host: string | undefined;
  searchEngine: string | undefined;
  /** Directory the always-on skills tools scan. From `--skills-path`; absent
   * means the CLI default `.agents/skills` applies (ADR 0009). */
  skillsPath: string | undefined;
  prompt: string;
  help: boolean;
}

/** Splits the agent's argv into its flags and the remaining prompt, or
 * signals `--help`/`-h`. Flags must come before the prompt; the first
 * non-flag token (or a `--` terminator) begins the prompt, so a one-shot
 * prompt can contain dashes once it has started. */
export function parseAgentArgs(args: string[]): AgentArgs {
  const tools: string[] = [];
  const cliCommands: string[] = [];
  let systemPrompt: string | undefined;
  let model: ModelSelection | undefined;
  let host: string | undefined;
  let searchEngine: string | undefined;
  let skillsPath: string | undefined;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (isHelpFlag(arg)) {
      return {
        tools: [],
        cliCommands: [],
        systemPrompt: undefined,
        model: undefined,
        host: undefined,
        searchEngine: undefined,
        skillsPath: undefined,
        prompt: "",
        help: true,
      };
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
    const inlineTools = toolsInlineValue(arg);
    if (inlineTools !== undefined) {
      tools.push(...parseList(inlineTools));
      continue;
    }
    // Space and `=` forms of a flag whose value must be non-empty. The space
    // form consumes the next token verbatim, even when it looks like another
    // flag (ADR 0006 pins this for --system-prompt; all value flags match).
    const valueFlag = (name: string, example: string): string | undefined => {
      if (arg !== name && !arg.startsWith(`${name}=`)) return undefined;
      const value = arg === name ? args[++i] : arg.slice(name.length + 1);
      if (!value || value.trim() === "") {
        throw new Error(`Missing value for ${name}. Example: ${example}`);
      }
      return value;
    };
    const systemPromptValue = valueFlag(
      "--system-prompt",
      '--system-prompt "Be a SQL expert."',
    );
    if (systemPromptValue !== undefined) {
      systemPrompt = systemPromptValue;
      continue;
    }
    const modelValue = valueFlag(
      "--model",
      "--model anthropic/claude-haiku-4-5",
    );
    if (modelValue !== undefined) {
      model = parseModelValue(modelValue);
      continue;
    }
    const cliCommandsValue = valueFlag(
      "--cli-commands",
      "--cli-commands deno,git",
    );
    if (cliCommandsValue !== undefined) {
      cliCommands.push(...parseList(cliCommandsValue));
      continue;
    }
    const hostValue = valueFlag("--host", "--host http://localhost:11434");
    if (hostValue !== undefined) {
      host = hostValue;
      continue;
    }
    const searchEngineValue = valueFlag(
      "--search-engine",
      "--search-engine brave",
    );
    if (searchEngineValue !== undefined) {
      searchEngine = searchEngineValue;
      continue;
    }
    const skillsPathValue = valueFlag(
      "--skills-path",
      "--skills-path ./.agents/skills",
    );
    if (skillsPathValue !== undefined) {
      skillsPath = skillsPathValue;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(
        `Unknown flag "${arg}". The agent accepts --model <provider/model>, ` +
          "--tools <list>, --system-prompt <text>, --cli-commands <list>, " +
          "--host <url>, --search-engine <brave|perplexity>, and " +
          "--skills-path <dir>.",
      );
    }
    break;
  }
  return {
    tools,
    cliCommands,
    systemPrompt,
    model,
    host,
    searchEngine,
    skillsPath,
    prompt: args.slice(i).join(" ").trim(),
    help: false,
  };
}

/** Parses a `--model` value of the form `provider/model`. The split is on the
 * first slash so a model id may itself contain slashes (as ids on
 * OpenAI-compatible routers often do). */
function parseModelValue(value: string): ModelSelection {
  const slash = value.indexOf("/");
  const provider = slash === -1 ? "" : value.slice(0, slash).trim();
  const modelId = slash === -1 ? value.trim() : value.slice(slash + 1).trim();
  if (!provider || !modelId || slash === -1) {
    throw new Error(
      `Invalid --model value "${value}". Expected provider/model, ` +
        "e.g. --model anthropic/claude-haiku-4-5",
    );
  }
  return { provider: provider.toLowerCase(), modelId };
}

/** Returns the value of a `--tools=`/`--tool=` token, or undefined otherwise.
 * Unlike the value flags, an empty list value is allowed and means "no
 * tools", so `--tools` does not go through the non-empty check. */
function toolsInlineValue(arg: string): string | undefined {
  for (const prefix of ["--tools=", "--tool="]) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}
