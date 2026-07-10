import { isHelpFlag } from "../command.ts";
import { parseList } from "./env.ts";

/** The provider and model a `--model provider/model` flag selects. The
 * provider is normalized to lowercase; the model id keeps its case. */
export interface ModelSelection {
  provider: string;
  modelId: string;
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
  model: ModelSelection | undefined;
  prompt: string;
  help: boolean;
} {
  const tools: string[] = [];
  let systemPrompt: string | undefined;
  let model: ModelSelection | undefined;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (isHelpFlag(arg)) {
      return {
        tools: [],
        systemPrompt: undefined,
        model: undefined,
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
    if (arg === "--model") {
      const value = args[++i];
      if (!value || value.trim() === "") {
        throw new Error(
          "Missing value for --model. Example: --model anthropic/claude-haiku-4-5",
        );
      }
      model = parseModelValue(value);
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
    const inlineModel = modelInlineValue(arg);
    if (inlineModel !== undefined) {
      if (inlineModel.trim() === "") {
        throw new Error(
          "Missing value for --model. Example: --model anthropic/claude-haiku-4-5",
        );
      }
      model = parseModelValue(inlineModel);
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(
        `Unknown flag "${arg}". The agent accepts --model <provider/model>, ` +
          "--tools <list>, and --system-prompt <text>.",
      );
    }
    break;
  }
  return {
    tools,
    systemPrompt,
    model,
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

/** Returns the value of a `--model=` token, or undefined otherwise. */
function modelInlineValue(arg: string): string | undefined {
  const prefix = "--model=";
  if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  return undefined;
}
