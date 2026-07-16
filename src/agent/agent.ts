import { red } from "../terminal.ts";
import { parseAgentArgs } from "./args.ts";
import { type Assistant, chat } from "./chat.ts";
import { setup } from "./setup.ts";
import { SUBAGENT_SUMMARIES } from "./subagents/mod.ts";
import { allToolNames } from "./tools.ts";

export default async (args: string[] = []): Promise<string> => {
  let assistant: Assistant;
  let prompt: string;
  try {
    // A bad flag (--tools, --model, --cli-commands, ...) is rendered like a
    // turn error, not a crash.
    const parsed = parseAgentArgs(args);
    if (parsed.help) return agentHelp();
    prompt = parsed.prompt;
    assistant = await setup(parsed);
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

EXAMPLES
  huuma agent "What is the capital of France?"
  huuma agent --model anthropic/claude-haiku-4-5 "Explain git rebase"
  huuma agent --tools read_file,grep "What does src/mod.ts export?"
  huuma agent --tools files,cli --cli-commands deno,git "Run the tests"
  huuma agent --skills-path ./other-skills "What skills are installed there?"
  huuma agent --system-prompt "Be a SQL expert, answer only in SQL." "select all users"`;
}
