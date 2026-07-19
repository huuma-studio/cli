/**
 * Managed-turn lifecycle orchestration (T5).
 *
 * {@link runManagedTurn} connects three pieces produced by the earlier
 * managed-turn tasks into one sequential Turn runner:
 *
 * - T4's {@link loadManagedInput} splits the persisted history into the
 *   `agent.run` prompt (the final triggering user message's contents) and
 *   the preceding `history` argument. Called BEFORE the agent factory so a
 *   relative `--history` path resolves against the CLI invocation cwd, not
 *   `--cwd` (which the real `managedSetup` chdirs into).
 * - The injected {@link ManagedTurnDeps.agentFactory} builds the Agent from
 *   the validated {@link ManagedConfig}. T6 wires this to `managedSetup`;
 *   T7 substitutes a fake Agent at the same boundary.
 * - T3's {@link CallbackReporter} delivers lifecycle and message events to
 *   the Studio callback URL with strict delivery semantics.
 *
 * Execution flow (PLAN.md "Execution flow" L301-337):
 *
 *  1. Construct the `CallbackReporter` (early, so setup/input failures can
 *     still produce `turn.failed` when delivery remains possible).
 *  2. Load managed input.
 *  3. Build the Agent.
 *  4. Deliver `turn.running` and await its acknowledgement.
 *  5. Run `agent.run(prompt, history, { onMessage, onMessageError: "throw" })`
 *     exactly once. `onMessage` verifies and suppresses the first emitted
 *     triggering user message (Studio owns sequence 0), then delivers every
 *     subsequent message via `reporter.messageAppended` with monotonically
 *     increasing `turn_sequence` from 1, awaiting each acknowledgement
 *     before returning (backpressure).
 *  6. Decode the successful `finish_turn` outcome from the returned
 *     `Message[]` (walk backwards for the last `tool` message containing a
 *     successful `finish_turn` tool result).
 *  7. Deliver `turn.finished` with the decoded outcome. This is the only
 *     path to exit 0.
 *
 * Terminal invariant: at most one terminal event (`turn.finished` OR
 * `turn.failed`) is attempted per Turn, guarded by `terminalAttempted`. The
 * two share the `<turn-id>:terminal` idempotency key, so a failed terminal
 * delivery is never replaced by the other terminal event — reconciliation
 * handles the absent acknowledgement (PLAN, "Never switch to the other
 * terminal event").
 *
 * Exit-code invariant: `Deno.exitCode` is set to 0 only after
 * `turn.finished` was delivered and acknowledged; 1 on every other path.
 * The function never calls `Deno.exit()` — the caller (T6) owns process
 * termination.
 */
import type {
  FileContent,
  Message,
  TextContent,
  ToolResultContent,
} from "@huuma/ai/agent";
import type { Assistant } from "../chat.ts";
import {
  type CallbackDeps,
  CallbackError,
  CallbackReporter,
  sanitizeError,
} from "./callback.ts";
import type { ManagedConfig } from "./config.ts";
import { loadManagedInput } from "./input.ts";

/** Injectable dependencies for {@link runManagedTurn}. */
export interface ManagedTurnDeps {
  /** Builds the Agent from the validated config. T6 wires this to
   * `managedSetup`; T7 injects a fake Agent factory for integration tests.
   * The factory MAY chdir into `config.cwd` (the real `managedSetup` does);
   * the runner calls `loadManagedInput` before this factory so a relative
   * `--history` path resolves against the CLI invocation cwd. */
  agentFactory: (config: ManagedConfig) => Promise<Assistant>;
  /** Injectable callback deps (fetch/now/sleep/random) for deterministic
   * delivery behavior. T6 injects production deps; T7 injects fakes. */
  callbackDeps: CallbackDeps;
}

/** Runs one managed turn: load input → build agent → turn.running →
 * agent.run with backpressured message.appended → turn.finished or
 * turn.failed. Sets `Deno.exitCode` (0 only after turn.finished was
 * acknowledged; 1 for every other path). Never calls `Deno.exit()` —
 * the caller owns process termination. */
export async function runManagedTurn(
  config: ManagedConfig,
  deps: ManagedTurnDeps,
): Promise<void> {
  // 1. Construct the reporter FIRST. Setup and input failures can still
  //    produce `turn.failed` if delivery remains possible (PLAN: "Initialize
  //    the reporter early enough that sanitized setup failures can produce
  //    turn.failed when delivery remains possible"). The reporter takes a
  //    URL string per its T3 design.
  const reporter = new CallbackReporter({
    callbackUrl: config.callbackUrl.href,
    callbackSecret: config.callbackSecret,
    runId: config.runId,
    turnId: config.turnId,
    turnDeadline: config.turnDeadline,
    deps: deps.callbackDeps,
  });

  // Terminal invariant guard: at most one terminal event is attempted per
  // Turn. Both `turn.finished` and `turn.failed` share the
  // `<turn-id>:terminal` idempotency key, so a second terminal attempt
  // would either conflict (409) or duplicate — both forbidden by the
  // callback contract.
  let terminalAttempted = false;

  /** Attempts `turn.failed` exactly once with a sanitized error. If the
   * terminal delivery itself fails, swallows the error — there is no
   * retry and no switch to `turn.finished` (PLAN: "a conflict on the
   * shared terminal key cannot be replaced by a second terminal event"). */
  const attemptTurnFailed = async (error: unknown): Promise<void> => {
    if (terminalAttempted) return;
    terminalAttempted = true;
    try {
      await reporter.turnFailed(sanitizeError(error));
    } catch {
      // Terminal delivery failed. Reconciliation handles the absent
      // acknowledgement; the caller observes a non-zero exit code.
    }
  };

  // 2. Load the managed input BEFORE the agent factory. The real
  //    `managedSetup` chdir's into `config.cwd`, and a relative `--history`
  //    path must resolve against the CLI invocation cwd (PLAN, T4
  //    follow-up).
  let input: {
    prompt: string | (TextContent | FileContent)[];
    history: Message[];
  };
  try {
    input = await loadManagedInput(config);
  } catch (error) {
    // Input failures are not CallbackErrors (no callback has been sent
    // yet); fall through to the standard "attempt turn.failed" path.
    await attemptTurnFailed(error);
    Deno.exitCode = 1;
    return;
  }

  // 3. Build the Agent. `managedSetup` may throw on setup failure (bad
  //    tools, missing credentials, unknown provider — `resolveManagedConfig`
  //    caught most of these, but `managedSetup` still enforces
  //    `--host`-only-for-ollama and defensive API-key checks).
  let assistant: Assistant;
  try {
    assistant = await deps.agentFactory(config);
  } catch (error) {
    await attemptTurnFailed(error);
    Deno.exitCode = 1;
    return;
  }

  // 4. Deliver `turn.running` and await its acknowledgement before starting
  //    the Agent (PLAN, "Execution flow" step 4).
  try {
    await reporter.turnRunning();
  } catch (error) {
    if (isAuthStop(error)) {
      // 401/403: stop immediately, send nothing else (PLAN, "After 401 or
      // 403, stop immediately and do not attempt turn.failed").
      Deno.exitCode = 1;
      return;
    }
    // conflict | fatal-failable | budget-exhausted: attempt turn.failed.
    await attemptTurnFailed(error);
    Deno.exitCode = 1;
    return;
  }

  // 5. Run the Agent loop exactly once per Turn execution. `onMessage`
  //    verifies and suppresses the first emission (the triggering user
  //    message Studio already persisted as sequence 0), then delivers every
  //    subsequent message with backpressure: each `message.appended` is
  //    awaited before `onMessage` returns, and `onMessageError: "throw"`
  //    propagates delivery errors out of `agent.run`.
  let firstEmission = true;
  let turnSequence = 0;
  const onMessage = async (message: Message): Promise<void> => {
    if (firstEmission) {
      firstEmission = false;
      // Verify and suppress the already-persisted triggering user message.
      // A mismatch is a protocol failure: throw so `onMessageError: "throw"`
      // aborts the loop and the runner reports `turn.failed`.
      if (
        message.role !== "user" ||
        !contentsEqual(message.contents, input.prompt)
      ) {
        throw new Error(
          "protocol failure: the first message emitted by agent.run did " +
            'not match the triggering user message. Expected role "user" ' +
            "with contents equal to the managed-turn prompt; received " +
            `role "${message.role}".`,
        );
      }
      return; // Suppress — Studio owns sequence 0.
    }
    turnSequence += 1;
    await reporter.messageAppended(turnSequence, message);
  };

  let messages: Message[];
  try {
    messages = await assistant.run(input.prompt, input.history, {
      onMessage,
      onMessageError: "throw",
    });
  } catch (error) {
    if (isAuthStop(error)) {
      // 401/403 mid-loop: stop immediately, send nothing else.
      Deno.exitCode = 1;
      return;
    }
    // CallbackError (conflict | fatal-failable | budget-exhausted) from
    // `message.appended` delivery, OR a non-callback Error (provider error,
    // first-emission protocol failure). The already-acknowledged
    // contiguous message prefix is preserved naturally — those events were
    // delivered before `onMessage` threw.
    await attemptTurnFailed(error);
    Deno.exitCode = 1;
    return;
  }

  // 6. Decode the `finish_turn` outcome from the returned messages. Loop
  //    end without a successful `finish_turn` is a protocol failure (PLAN:
  //    "the loop ended without finish_turn (a protocol failure — report it
  //    as a failure; never guess an outcome)").
  const outcome = decodeFinishTurnOutcome(messages);
  if (outcome === undefined) {
    await attemptTurnFailed(
      new Error("agent loop ended without a successful finish_turn call"),
    );
    Deno.exitCode = 1;
    return;
  }

  // 7. Deliver `turn.finished`. This happens AFTER all `message.appended`
  //    events are acknowledged (inherent — `onMessage` awaited each, and
  //    `agent.run` has returned). Mark `terminalAttempted` before the call:
  //    a failed terminal delivery is never replaced by `turn.failed` (both
  //    share the `<turn-id>:terminal` key).
  terminalAttempted = true;
  try {
    await reporter.turnFinished(outcome);
    Deno.exitCode = 0;
  } catch {
    // Terminal delivery failed. Never switch to `turn.failed`.
    Deno.exitCode = 1;
  }
}

/** Returns `true` when `error` is a `CallbackError` with kind `auth-stop`
 * (401/403). These errors halt all delivery: the runner sets a non-zero
 * exit code and returns without attempting `turn.failed` (PLAN, "After 401
 * or 403, stop immediately and do not attempt turn.failed"). */
function isAuthStop(error: unknown): boolean {
  return error instanceof CallbackError && error.kind === "auth-stop";
}

/** Deep-equality check for the first-emission verification. The triggering
 * user message's contents are `string | (TextContent | FileContent)[]` —
 * JSON-serializable — so `JSON.stringify` comparison is sufficient and
 * deterministic. Ordering of object keys is preserved by V8's insertion-
 * order stringification, which is stable for content parts built by
 * `@huuma/ai` and our own history loader. */
function contentsEqual(
  actual: string | (TextContent | FileContent)[],
  expected: string | (TextContent | FileContent)[],
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/** Decodes the successful `finish_turn` outcome from the returned native
 * `Message[]`. Walks backwards for the last `tool` message containing a
 * successful `finish_turn` tool result (`toolResult.name === "finish_turn"`,
 * `toolResult.result.error === undefined`, `output.outcome ∈
 * {"question", "completion"}`). Returns `undefined` when no such result
 * exists — the caller reports that as a protocol failure. Mirrors
 * `decodeFinishTurnOutcome` in `ai_api_fixture.ts` (T1). */
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
        | { outcome?: "question" | "completion" }
        | undefined;
      if (output?.outcome === "question" || output?.outcome === "completion") {
        return output.outcome;
      }
    }
  }
  return undefined;
}
