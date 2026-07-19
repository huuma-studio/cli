import { isHelpFlag } from "../command.ts";
import { parseList } from "./env.ts";

/** The provider and model a `--model provider/model` flag selects. The
 * provider is normalized to lowercase; the model id keeps its case. */
export interface ModelSelection {
  provider: string;
  modelId: string;
}

/** Local chat mode — the existing default. With a positional prompt the agent
 * answers once and exits; without one it starts the interactive REPL. The
 * provider and model come from `--model` or, when absent, from interactive
 * prompts inside `setup`. Behavioral configuration lives in flags, never env
 * vars, so a tooled agent cannot rewrite it for future runs (ADR 0007,
 * ADR 0008); only secrets stay in the environment. */
export interface LocalAgentArgs {
  mode: "local";
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
  help: false;
}

/** Managed turn mode — selected explicitly by the presence of
 * `--callback-url`. The triggering user message already exists at the end of
 * `--history`, so a positional prompt is rejected at parse time and `prompt`
 * is always `""` here. The full managed-turn flag group and the provider's
 * non-interactive credential/host requirements are validated atomically by
 * {@link resolveManagedConfig} before any prompt, stdin read, model call, or
 * callback is attempted (PLAN, "Command modes" and "Execution flow").
 *
 * The managed-only fields below are `string | undefined` at the parse layer:
 * `--callback-url` selects the mode, the others are required-together but their
 * presence and shape are enforced by {@link resolveManagedConfig}. */
export interface ManagedAgentArgs {
  mode: "managed";
  // Shared agent options (available in both modes):
  tools: string[];
  cliCommands: string[];
  systemPrompt: string | undefined;
  model: ModelSelection | undefined;
  host: string | undefined;
  searchEngine: string | undefined;
  skillsPath: string | undefined;
  /** Always `""` in managed mode — positional prompts are rejected. */
  prompt: string;
  help: false;
  // Managed-turn-only flags (validated atomically by resolveManagedConfig):
  history: string | undefined;
  cwd: string | undefined;
  /** Presence of `--callback-url` is what selects managed turn mode. */
  callbackUrl: string;
  runId: string | undefined;
  turnId: string | undefined;
  turnDeadline: string | undefined;
}

/** `--help` / `-h` short-circuits before mode selection. The runner returns
 * the usage text without parsing flags or selecting a mode. */
export interface HelpAgentArgs {
  help: true;
}

/** The agent's parsed argv. `--help`/`-h` short-circuits before mode selection;
 * otherwise the `mode` discriminant selects local chat (the existing default,
 * entered when `--callback-url` is absent) or managed turn mode (entered when
 * `--callback-url` is present). */
export type ParsedAgentArgs =
  | HelpAgentArgs
  | LocalAgentArgs
  | ManagedAgentArgs;

/** Splits the agent's argv into its flags and the remaining prompt, or
 * signals `--help`/`-h`. Flags must come before the prompt; the first
 * non-flag token (or a `--` terminator) begins the prompt, so a one-shot
 * prompt can contain dashes once it has started.
 *
 * Mode is selected by `--callback-url`: when present, the parse result is a
 * {@link ManagedAgentArgs} and a positional prompt is rejected (the
 * triggering user message already exists at the end of `--history`). When
 * `--callback-url` is absent, supplying any other managed-turn-only flag
 * (`--history`, `--cwd`, `--run-id`, `--turn-id`, `--turn-deadline`) is a
 * configuration error rather than a local chat that ignores them. Value
 * validation of the managed flag group — required-together, UUID shape,
 * callback URL, RFC3339 deadline, secret, provider credentials — happens
 * later in `resolveManagedConfig`; this function only parses flag values and
 * selects the mode. */
export function parseAgentArgs(args: string[]): ParsedAgentArgs {
  const tools: string[] = [];
  const cliCommands: string[] = [];
  let systemPrompt: string | undefined;
  let model: ModelSelection | undefined;
  let host: string | undefined;
  let searchEngine: string | undefined;
  let skillsPath: string | undefined;
  let history: string | undefined;
  let cwd: string | undefined;
  let callbackUrl: string | undefined;
  let runId: string | undefined;
  let turnId: string | undefined;
  let turnDeadline: string | undefined;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (isHelpFlag(arg)) {
      return { help: true };
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
    // Managed-turn-only flags. Parsed in both forms like every other value
    // flag. --callback-url selects managed mode; the others are rejected after
    // the loop if --callback-url is absent (a partial managed turn is a
    // configuration error, not a local chat with ignored options).
    const historyValue = valueFlag(
      "--history",
      "--history /workspace/history.json",
    );
    if (historyValue !== undefined) {
      history = historyValue;
      continue;
    }
    const cwdValue = valueFlag("--cwd", "--cwd /workspace");
    if (cwdValue !== undefined) {
      cwd = cwdValue;
      continue;
    }
    const callbackUrlValue = valueFlag(
      "--callback-url",
      "--callback-url https://api.huuma.studio/runs/123/callback",
    );
    if (callbackUrlValue !== undefined) {
      callbackUrl = callbackUrlValue;
      continue;
    }
    const runIdValue = valueFlag(
      "--run-id",
      "--run-id 00000000-0000-0000-0000-000000000000",
    );
    if (runIdValue !== undefined) {
      runId = runIdValue;
      continue;
    }
    const turnIdValue = valueFlag(
      "--turn-id",
      "--turn-id 00000000-0000-0000-0000-000000000000",
    );
    if (turnIdValue !== undefined) {
      turnId = turnIdValue;
      continue;
    }
    const turnDeadlineValue = valueFlag(
      "--turn-deadline",
      "--turn-deadline 2026-07-19T12:00:00Z",
    );
    if (turnDeadlineValue !== undefined) {
      turnDeadline = turnDeadlineValue;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(
        `Unknown flag "${arg}". The agent accepts --model <provider/model>, ` +
          "--tools <list>, --system-prompt <text>, --cli-commands <list>, " +
          "--host <url>, --search-engine <brave|perplexity>, " +
          "--skills-path <dir>, and the managed-turn flags --history <path>, " +
          "--cwd <dir>, --callback-url <url>, --run-id <uuid>, " +
          "--turn-id <uuid>, and --turn-deadline <RFC3339>.",
      );
    }
    break;
  }
  const prompt = args.slice(i).join(" ").trim();

  // Mode selection. --callback-url selects managed turn mode; any other
  // managed-turn-only flag without --callback-url is a configuration error,
  // not a local chat with ignored options. Report the first such flag in a
  // fixed canonical order so the failure is deterministic.
  if (callbackUrl === undefined) {
    const orphaned = [
      ["--history", history] as const,
      ["--cwd", cwd] as const,
      ["--run-id", runId] as const,
      ["--turn-id", turnId] as const,
      ["--turn-deadline", turnDeadline] as const,
    ].find(([, value]) => value !== undefined);
    if (orphaned !== undefined) {
      const [flag] = orphaned;
      throw new Error(
        `${flag} is a managed-turn flag and requires --callback-url. Pass ` +
          "--callback-url to enter managed turn mode, or remove the flag.",
      );
    }
    return {
      mode: "local",
      tools,
      cliCommands,
      systemPrompt,
      model,
      host,
      searchEngine,
      skillsPath,
      prompt,
      help: false,
    };
  }

  // Managed turn mode rejects a positional prompt: the triggering user message
  // already exists at the end of --history, so a prompt on the command line is
  // a misuse. Value validation of the flag group happens in
  // resolveManagedConfig; here we only enforce the mode shape.
  if (prompt !== "") {
    throw new Error(
      "A positional prompt is not allowed in managed turn mode. The " +
        "triggering user message already exists at the end of --history.",
    );
  }

  return {
    mode: "managed",
    tools,
    cliCommands,
    systemPrompt,
    model,
    host,
    searchEngine,
    skillsPath,
    prompt: "",
    help: false,
    history,
    cwd,
    callbackUrl,
    runId,
    turnId,
    turnDeadline,
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
