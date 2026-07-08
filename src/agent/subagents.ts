import {
  agent,
  type AgentOptions,
  type Message,
  type OnMessage,
} from "@huuma/ai/agent";
import { grep, readFile, subagent } from "@huuma/ai/tools";
import { CLEAR_LINE, dim, write } from "../terminal.ts";

/** The provider adapter and model id a preset sub-agent runs on. Presets
 * inherit the parent's resolution (ADR 0005), so setup() passes the same
 * pair it builds the parent agent with. */
export interface SubagentContext<T extends string = string> {
  model: AgentOptions<T>["model"];
  modelId: T;
}

/** The agent's tool list, derived like agent.ts's `AgentTools` so both
 * track @huuma/ai rather than re-declaring the element type. */
type AgentTools = NonNullable<AgentOptions<string>["tools"]>;

type SubagentFactory = <T extends string>(
  ctx: SubagentContext<T>,
) => AgentTools;

/** Preset sub-agent factories keyed by the name used on the `--tools` flag,
 * mirroring agent.ts's TOOL_FACTORIES. They live in their own registry
 * because a sub-agent needs the resolved model, which only exists after the
 * provider prompts — regular tools keep failing before them (ADR 0005). */
export const SUBAGENT_FACTORIES: Record<string, SubagentFactory> = {
  explorer: (ctx) => [explorer(ctx)],
};

/** One-sentence help entries, keyed like {@link SUBAGENT_FACTORIES} so the
 * SUBAGENTS section of --help cannot list a preset that doesn't exist. */
export const SUBAGENT_SUMMARIES: Record<
  keyof typeof SUBAGENT_FACTORIES,
  string
> = {
  explorer:
    "delegates a read-only investigation (read_file, grep) to a fresh sub-agent",
};

/** No parent history crosses the delegation boundary, so the description
 * must make the parent model send self-contained prompts. */
const EXPLORER_DESCRIPTION =
  "Delegate a read-only file or codebase investigation to a research " +
  "sub-agent equipped with read_file and grep. The sub-agent shares no " +
  "conversation history, so provide a self-contained prompt with all " +
  "needed context and file paths. Returns concise findings.";

const EXPLORER_SYSTEM_PROMPT =
  "You are Explorer, a read-only research sub-agent. Investigate the files " +
  "described in the prompt using your read_file and grep tools, then reply " +
  "with concise findings in plain text — conclusions and the file paths " +
  "that support them, not a transcript of what you did.";

function explorer<T extends string>(
  ctx: SubagentContext<T>,
): AgentTools[number] {
  return subagent({
    name: "explorer",
    description: EXPLORER_DESCRIPTION,
    agent: agent({
      model: ctx.model,
      modelId: ctx.modelId,
      systemPrompt: EXPLORER_SYSTEM_PROMPT,
      tools: [readFile(), grep()],
      onMessage: announceDelegation("explorer"),
    }),
  });
}

/** An {@link OnMessage} that prints one dim status line per delegation —
 * the run's initial user message — and stays silent for the sub-agent's
 * model and tool messages, which never surface in the parent's output
 * (ADR 0005). The parent's "Thinking..." line is cleared and re-written so
 * the status line lands on its own line. */
export function announceDelegation(name: string): OnMessage {
  return (message) => {
    if (message.role !== "user") return;
    write(CLEAR_LINE);
    console.log(dim(`${name} ← ${oneLine(messageText(message))}`));
    write(dim("Thinking..."));
  };
}

/** The text of a message whose contents may be a plain string (the shape a
 * delegation prompt arrives in) or content parts. */
function messageText(message: Message): string {
  const { contents } = message;
  if (typeof contents === "string") return contents;
  return contents
    .map((content) => "text" in content ? content.text : "")
    .filter(Boolean)
    .join(" ");
}

/** Collapses whitespace and truncates so the status line stays a single
 * terminal-friendly line. */
function oneLine(text: string, max = 60): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}
