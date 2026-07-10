import type { AgentOptions, Message, OnMessage } from "@huuma/ai/agent";
import { CLEAR_LINE, dim, write } from "../../terminal.ts";
import { explorer } from "./explorer.ts";

/** The provider adapter and model id a preset sub-agent runs on. Presets
 * inherit the parent's resolution (ADR 0005), so setup() passes the same
 * pair it builds the parent agent with. */
export interface SubagentContext<T extends string = string> {
  model: AgentOptions<T>["model"];
  modelId: T;
}

/** The agent's tool list, derived like tools.ts's `AgentTools` so both
 * track @huuma/ai rather than re-declaring the element type. */
export type AgentTools = NonNullable<AgentOptions<string>["tools"]>;

export type SubagentFactory = <T extends string>(
  ctx: SubagentContext<T>,
) => AgentTools;

/** Preset sub-agent factories keyed by the name used on the `--tools` flag,
 * mirroring tools.ts's TOOL_FACTORIES. They live in their own registry
 * because a sub-agent needs the resolved model, which only exists after the
 * provider prompts — regular tools keep failing before them (ADR 0005). */
export const SUBAGENT_FACTORIES: Record<string, SubagentFactory> = {
  explorer: (ctx) => [explorer(ctx)],
};

/** One-sentence help entries, keyed like {@link SUBAGENT_FACTORIES} so the
 * SUBAGENTS section of --help cannot list a preset that doesn't exist.
 * The strings live here, not in the preset modules — a preset export read
 * at this module's top level would hit the mod ⇄ preset import cycle
 * before the preset module has initialized. */
export const SUBAGENT_SUMMARIES: Record<
  keyof typeof SUBAGENT_FACTORIES,
  string
> = {
  explorer:
    "delegates a read-only investigation (read_file, grep) to a fresh sub-agent",
};

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
