import { red } from "../terminal.ts";
import { parseAgentArgs } from "./args.ts";
import { chat } from "./chat.ts";
import type { CallbackDeps, ResponseLike } from "./managed/callback.ts";
import { resolveManagedConfig } from "./managed/config.ts";
import { runManagedTurn } from "./managed/runner.ts";
import { managedSetup, setup } from "./setup.ts";
import { SUBAGENT_SUMMARIES } from "./subagents/mod.ts";
import { allToolNames } from "./tools.ts";

/** Production {@link CallbackDeps} for managed turn mode. The reporter does
 * not enforce per-attempt timeouts itself (PLAN, "Callback contract"); the
 * `fetch` here enforces `init.timeoutMs` via `AbortSignal.timeout`. The
 * standard `Response` is a superset of {@link ResponseLike}, so the cast is a
 * safe narrowing. `now`/`sleep`/`random` use the obvious built-ins. */
const productionCallbackDeps: CallbackDeps = {
  fetch: (url, init) =>
    fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body as BodyInit,
      signal: AbortSignal.timeout(init.timeoutMs),
    }) as Promise<ResponseLike>,
  now: () => new Date(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

export default async (args: string[] = []): Promise<string> => {
  try {
    // A bad flag (--tools, --model, --cli-commands, ...) is rendered like a
    // turn error, not a crash. --help short-circuits before mode dispatch.
    const parsed = parseAgentArgs(args);
    if (parsed.help) return agentHelp();

    if (parsed.mode === "managed") {
      // Managed turn mode: validate the atomic flag group, run one non-
      // interactive turn, and return. Never reads stdin, never falls through
      // to local chat. `resolveManagedConfig` throws on validation errors
      // (naming only the flag/env var, never a secret); `runManagedTurn` sets
      // `Deno.exitCode` (0 after turn.finished was acknowledged, 1 otherwise)
      // and never calls `Deno.exit()`. Errors from either propagate to the
      // outer catch, which prints the message and sets a non-zero exit code.
      const config = resolveManagedConfig(parsed);
      await runManagedTurn(config, {
        agentFactory: managedSetup,
        callbackDeps: productionCallbackDeps,
      });
      return "";
    }

    // Local chat mode (the existing default — unchanged). `parsed` narrows to
    // `LocalAgentArgs` here, which is structurally compatible with
    // `SetupOptions`.
    const assistant = await setup(parsed);
    return await chat(assistant, parsed.prompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${red("✖")} ${red(message)}\n`);
    Deno.exitCode = 1;
    return "";
  }
};

/** Usage text shown for `huuma agent --help`. The tool list is derived from
 * {@link allToolNames} so it can't drift from what `--tools` accepts. */
function agentHelp(): string {
  return `Chat with an AI agent in your terminal.

USAGE
  huuma agent [OPTIONS] [PROMPT]

  With a PROMPT the agent answers once and exits. Without one it starts an
  interactive session — type "exit" or "quit" to leave.

OPTIONS
  --model <provider/model>  Provider and model for this run, e.g.
                            anthropic/claude-haiku-4-5 (without the flag the
                            agent asks; providers: anthropic, openai, google,
                            mistral, ollama)
  --host <url>              Ollama host (default http://localhost:11434);
                            only valid with the ollama provider
  --tools <list>            Comma-separated action tools to enable (default: none;
                            the skills tools are always on — see below)
  --cli-commands <list>     Allow-list for the cli tool, e.g. deno,git
  --search-engine <engine>  Engine for the search tool: brave | perplexity
  --skills-path <dir>       Directory the skills tools scan (default:
                            .agents/skills); skills are always enabled
  --system-prompt <text>    Replace the built-in system prompt for this run;
                            output style is then yours to manage
  -h, --help                Show this help

TOOLS
  ${allToolNames().join(", ")}
  ("files" is shorthand for every file tool; "skills" expands to
  list_skills and retrieve_skill and is always enabled — it does not need
  to be listed here)

SUBAGENTS
${
    Object.entries(SUBAGENT_SUMMARIES)
      .map(([name, summary]) => `  ${name} — ${summary}`)
      .join("\n")
  }
  Enabled like any tool (--tools explorer); the model decides when to
  delegate. Sub-agents run on the same provider and model as the agent.

ENVIRONMENT (secrets only — everything else is a flag)
  HUUMA_AGENT_API_KEY                 provider API key (omit for a local Ollama)
  BRAVE_API_KEY / PERPLEXITY_API_KEY  API key for the chosen search engine
  HUUMA_AGENT_CALLBACK_SECRET         per-turn callback secret (managed mode
                                      only; never a flag, never logged)

EXAMPLES
  huuma agent "What is the capital of France?"
  huuma agent --model anthropic/claude-haiku-4-5 "Explain git rebase"
  huuma agent --tools read_file,grep "What does src/mod.ts export?"
  huuma agent --tools files,cli --cli-commands deno,git "Run the tests"
  huuma agent --skills-path ./other-skills "What skills are installed there?"
  huuma agent --system-prompt "Be a SQL expert, answer only in SQL." "select all users"

MANAGED TURN MODE
  Adding --callback-url selects managed turn mode: a single non-interactive
  turn driven by a persisted history and reported to a callback endpoint.
  Local chat is bypassed entirely — stdin is never read, no REPL starts,
  and a positional prompt is rejected (the triggering user message already
  exists at the end of --history).

  The managed flag group is atomic. When --callback-url is present ALL of
  these are required together:
    --callback-url <url>      callback endpoint (http or https)
    --history <path>          JSON file with the native Message[] history;
                              non-empty, ends with the triggering user message
    --cwd <dir>               working directory the agent starts in
    --run-id <uuid>           Studio Run id (RFC 4122)
    --turn-id <uuid>          Studio Turn id (RFC 4122)
    --turn-deadline <RFC3339> sandbox hard-expiry timestamp (UTC); at least
                              15 seconds must remain when the turn starts
    --model <provider/model>  provider and model (managed mode never prompts)

  Passing any of --history, --cwd, --run-id, --turn-id, or --turn-deadline
  without --callback-url is a configuration error, not a local chat with
  ignored options.

  Credentials:
    HUUMA_AGENT_CALLBACK_SECRET  required, non-empty (env var only — never a
                                flag, never echoed)
    HUUMA_AGENT_API_KEY          required for anthropic, openai, google, and
                                mistral; optional for unauthenticated ollama
    --host                       required for ollama (hosted providers ignore
                                it and reject it)

  Example (hosted provider):
    HUUMA_AGENT_CALLBACK_SECRET=secret \\
    HUUMA_AGENT_API_KEY=sk-... \\
    huuma agent \\
      --callback-url https://api.huuma.studio/runs/123/callback \\
      --history /workspace/history.json \\
      --cwd /workspace \\
      --run-id 11111111-1111-1111-1111-111111111111 \\
      --turn-id 22222222-2222-2222-2222-222222222222 \\
      --turn-deadline 2026-07-19T12:30:00Z \\
      --model anthropic/claude-haiku-4-5

  The runner posts turn.running, one message.appended per emitted message,
  and exactly one terminal event (turn.finished or turn.failed) to the
  callback URL. Exit 0 only after turn.finished was acknowledged.`;
}
