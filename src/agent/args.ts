import { isHelpFlag } from "../command.ts";
import { parseList } from "./env.ts";

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
