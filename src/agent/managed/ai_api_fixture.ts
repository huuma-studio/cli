/**
 * Compile-only type-level fixture for the exact `@huuma/ai@0.0.15` managed-turn
 * contract (T1).
 *
 * The file is intentionally never executed. It exists so `deno task check`
 * proves the pinned published release exposes:
 *  - `agent({ ..., finishTurn: true })` (the built-in `finish_turn` control
 *    tool, registered when `finishTurn: true` is set);
 *  - `agent.run(prompt, history, { onMessage, onMessageError: "throw" })`
 *    where the awaited `onMessage` rejection propagates from `run` when
 *    `onMessageError: "throw"` is set (so a delivery failure aborts the loop);
 *  - the returned native `Message[]`, including tool messages whose
 *    `toolResult.name === "finish_turn"` and whose `output` carries the
 *    `"question" | "completion"` outcome (typed as `FinishTurnOutput`).
 *
 * If a future `@huuma/ai` release renames, removes, or repurposes any of these,
 * this file stops type-checking and the consumer pin (T1) must move
 * deliberately rather than silently. See
 * `docs/specs/add-huuma-studio-support/PLAN.md` and ADRs 0007 / 0010.
 */
import { agent } from "@huuma/ai/agent";
import { anthropic } from "@huuma/ai/models/anthropic";
import type {
  FinishTurnOutput,
  Message,
  OnMessage,
  RunOptions,
  TextContent,
  ToolResultContent,
} from "@huuma/ai/agent";

/** The `prompt` argument of `Agent.run` accepts either a string or a
 * text/file part array — the contents of the triggering user message. */
type Prompt = string | (TextContent | { file: { mimeType: string } })[];

/** A `history` argument is the native `Message[]` the runner reconstructs
 * from `--history` minus the triggering user message. */
type History = Message[];

/** Build a managed Agent with `finishTurn: true` and an awaited `onMessage`.
 * The managed runner never registers a custom `finish_turn` tool — the
 * built-in one is the only outcome channel (PLAN, Non-goals). */
function buildManagedAgent(
  apiKey: string,
  modelId: string,
  onMessage: OnMessage,
): ReturnType<typeof agent> {
  return agent({
    model: anthropic({ apiKey }),
    modelId,
    systemPrompt: "managed-turn system prompt",
    tools: [],
    finishTurn: true,
    onMessage,
    onMessageError: "throw",
  });
}

/** Pin the exact `run` signature the runner uses: history second, options
 * third, with `onMessageError: "throw"` required for backpressure. */
function callRun(
  assistant: ReturnType<typeof buildManagedAgent>,
  prompt: Prompt,
  history: History,
  onMessage: OnMessage,
): Promise<Message[]> {
  const options: RunOptions = { onMessage, onMessageError: "throw" };
  return assistant.run(prompt, history, options);
}

/** Decode the successful `finish_turn` outcome from the returned native
 * messages. `output.outcome` is exactly `"question" | "completion"`; a
 * missing or failed `finish_turn` is a protocol failure the runner reports
 * as `turn.failed`, never a guessed outcome. */
function decodeFinishTurnOutcome(
  messages: Message[],
): "question" | "completion" | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "tool") continue;
    for (const content of message.contents) {
      if (!("toolResult" in content)) continue;
      const result = content as ToolResultContent;
      if (result.toolResult.name !== "finish_turn") continue;
      if (result.toolResult.result.error !== undefined) continue;
      const output = result.toolResult.result.output as
        | FinishTurnOutput
        | undefined;
      if (output === undefined) continue;
      return output.outcome;
    }
  }
  return undefined;
}

// Compile-only exports: nothing is exercised at runtime. The function bodies
// exist purely to anchor the type contract to the public `@huuma/ai@0.0.15`
// surface.
export const __typeCheck = {
  buildManagedAgent,
  callRun,
  decodeFinishTurnOutcome,
};
