import { red } from "../terminal.ts";
import { parseAgentArgs } from "./args.ts";
import { type Assistant, chat } from "./chat.ts";
import { setup } from "./setup.ts";
import { SUBAGENT_SUMMARIES } from "./subagents.ts";
import { allToolNames } from "./tools.ts";

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

/** Usage text shown for `huuma agent --help`. The tool list is derived from
 * {@link allToolNames} so it can't drift from what `--tools` accepts. */
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
  ${allToolNames().join(", ")}
  ("files" is shorthand for every file tool)

SUBAGENTS
${
    Object.entries(SUBAGENT_SUMMARIES)
      .map(([name, summary]) => `  ${name} — ${summary}`)
      .join("\n")
  }
  Enabled like any tool (--tools explorer); the model decides when to
  delegate. Sub-agents run on the same provider and model as the agent.

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
