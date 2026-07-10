import { agent } from "@huuma/ai/agent";
import { grep, readFile, subagent } from "@huuma/ai/tools";
import {
  type AgentTools,
  announceDelegation,
  type SubagentContext,
} from "./mod.ts";

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

export function explorer<T extends string>(
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
