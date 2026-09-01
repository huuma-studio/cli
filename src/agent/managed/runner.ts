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
 *  5. Run `agent.run(prompt, history, { onMessage, onMessageError: "throw" })`,
 *     retrying transient model failures with bounded backoff (ADR 0010).
 *     `onMessage` verifies and suppresses the first emitted triggering user
 *     message (Studio owns sequence 0) on every attempt, then delivers every
 *     subsequent message via `reporter.messageAppended` with monotonically
 *     increasing `turn_sequence` from 1, awaiting each acknowledgement
 *     before returning (backpressure). `turnSequence` is preserved across
 *     retries — already-delivered events keep their numbers — and no retry
 *     starts inside the 15 s terminal reserve before `--turn-deadline`.
 *  6. Decode the `finish_turn` outcome from the returned
 *     `Message[]` (walk backwards for the last `tool` message containing a
 *     `finish_turn` tool result). When no `finish_turn` was called at all,
 *     fall back to an implicit "question" outcome if the last model message
 *     is text-only (no tool calls). A failed or malformed `finish_turn` call
 *     is a protocol failure — the implicit-question fallback never applies
 *     when `finish_turn` was attempted.
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
 *
 * Retry amendment (ADR 0010): `agent.run` may be re-invoked after a
 * transient model failure (bounded by `--retries`), but the callback
 * contract is preserved on every attempt — single terminal event, monotonic
 * `turn_sequence`, and echo suppression via the re-armed first-emission
 * check. Callback/delivery errors and the first-emission protocol failure
 * are never classified as model failures and keep their existing paths.
 */
import type {
  FileContent,
  Message,
  TextContent,
  ToolResultContent,
} from "@huuma/ai/agent";
import type { McpConnection } from "@huuma/ai/tools";
import type { Assistant } from "../chat.ts";
import { reportAgentError } from "../diagnostics.ts";
import type { SetupResult } from "../setup.ts";
import { closeMcpConnections } from "../mcp.ts";
import {
  type CallbackDeps,
  CallbackError,
  CallbackReporter,
  TERMINAL_RESERVE_MS,
} from "./callback.ts";
import type { ManagedConfig } from "./config.ts";
import { loadManagedInput } from "./input.ts";
import { ProtocolError, runWithRetries, type RetryDeps } from "../retry.ts";

/** Injectable dependencies for {@link runManagedTurn}. */
export interface ManagedTurnDeps {
  /** Builds the Agent from the validated config. T6 wires this to
   * `managedSetup`; T7 injects a fake Agent factory for integration tests.
   * The factory MAY chdir into `config.cwd` (the real `managedSetup` does);
   * the runner calls `loadManagedInput` before this factory so a relative
   * `--history` path resolves against the CLI invocation cwd. Returns a
   * {@link SetupResult} so the runner can close MCP connections after the
   * turn. */
  agentFactory: (config: ManagedConfig) => Promise<SetupResult>;
  /** Injectable callback deps (fetch/now/sleep/random) for deterministic
   * delivery behavior. T6 injects production deps; T7 injects fakes. */
  callbackDeps: CallbackDeps;
  /** Error sink for sanitized managed-mode diagnostics. Defaults to
   * `console.error`; injectable so tests and embedders can capture output. */
  logError?: (message: string) => void;
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
  const logError = deps.logError ?? console.error;
  const reportError = (stage: string, error: unknown): string =>
    reportAgentError("managed", stage, error, logError);
  // MCP connections opened by the agent factory. Tracked so the `finally`
  // block can close them on every exit path (success, failure, early return).
  let mcpConnections: McpConnection[] = [];
  try {
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
    const attemptTurnFailed = async (
      stage: string,
      error: unknown,
    ): Promise<void> => {
      if (terminalAttempted) return;
      terminalAttempted = true;
      const message = reportError(stage, error);
      try {
        await reporter.turnFailed(message);
      } catch (deliveryError) {
        reportError("callback.turn_failed", deliveryError);
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
      await attemptTurnFailed("input", error);
      Deno.exitCode = 1;
      return;
    }

    // 3. Build the Agent. `managedSetup` may throw on setup failure (bad
    //    tools, missing credentials, unknown provider — `resolveManagedConfig`
    //    caught most of these, but `managedSetup` still enforces
    //    `--host`-only-for-ollama and defensive API-key checks). Returns a
    //    `SetupResult` so the runner can track MCP connections for cleanup.
    let assistant: Assistant;
    try {
      const result = await deps.agentFactory(config);
      assistant = result.assistant;
      mcpConnections = result.mcpConnections;
    } catch (error) {
      await attemptTurnFailed("setup", error);
      Deno.exitCode = 1;
      return;
    }

    // 4. Deliver `turn.running` and await its acknowledgement before starting
    //    the Agent (PLAN, "Execution flow" step 4).
    try {
      await reporter.turnRunning();
    } catch (error) {
      if (isAuthStop(error)) {
        reportError("callback.turn_running", error);
        // 401/403: stop immediately, send nothing else (PLAN, "After 401 or
        // 403, stop immediately and do not attempt turn.failed").
        Deno.exitCode = 1;
        return;
      }
      // conflict | fatal-failable | budget-exhausted: attempt turn.failed.
      await attemptTurnFailed("callback.turn_running", error);
      Deno.exitCode = 1;
      return;
    }

    // 5. Run the Agent loop, retrying transient model failures with bounded
    //    backoff (ADR 0010). `onMessage` verifies and suppresses the first
    //    emission (the triggering user message Studio already persisted as
    //    sequence 0), then delivers every subsequent message with
    //    backpressure: each `message.appended` is awaited before `onMessage`
    //    returns, and `onMessageError: "throw"` propagates delivery errors
    //    out of `agent.run`.
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
          // ProtocolError, not a plain Error: the retry core must classify
          // the mismatch permanent — it is deterministic and would repeat.
          throw new ProtocolError(
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

    // Each attempt re-arms the first-emission suppression: `agent.run`
    // re-emits the triggering user message first, and Studio keeps owning
    // sequence 0 on every attempt. `turnSequence` is deliberately NOT reset —
    // already-delivered `message.appended` events keep their numbers and new
    // messages continue monotonically from the delivered prefix (ADR 0010).
    const runAttempt = (): Promise<Message[]> => {
      firstEmission = true;
      return assistant.run(input.prompt, input.history, {
        onMessage,
        onMessageError: "throw",
      });
    };

    // Retry timing reuses the injected callback deps so tests stay
    // deterministic; the cutoff mirrors the non-terminal callback delivery
    // cutoff (`turnDeadline - TERMINAL_RESERVE_MS`), keeping the final 15
    // seconds reserved for terminal delivery.
    const retryDeps: RetryDeps = {
      now: deps.callbackDeps.now,
      sleep: deps.callbackDeps.sleep,
      random: deps.callbackDeps.random,
    };

    let messages: Message[];
    try {
      messages = await runWithRetries(
        runAttempt,
        {
          retries: config.retries,
          cutoffMs: config.turnDeadline.getTime() - TERMINAL_RESERVE_MS,
        },
        retryDeps,
      );
    } catch (error) {
      if (isAuthStop(error)) {
        reportError("callback.message_appended", error);
        // 401/403 mid-loop: stop immediately, send nothing else.
        Deno.exitCode = 1;
        return;
      }
      // CallbackError (conflict | fatal-failable | budget-exhausted) from
      // `message.appended` delivery, OR a non-callback Error (provider error
      // after exhausted retries, or the first-emission protocol failure).
      // The already-acknowledged contiguous message prefix is preserved
      // naturally — those events were delivered before `onMessage` threw.
      await attemptTurnFailed(
        error instanceof CallbackError
          ? "callback.message_appended"
          : "agent.run",
        error,
      );
      Deno.exitCode = 1;
      return;
    }

    // 6. Decode the `finish_turn` outcome from the returned messages.
    //    `decodeFinishTurnOutcome` returns:
    //      - "question" | "completion" — a successful finish_turn call.
    //      - "failed" — finish_turn was called but errored or produced a
    //        malformed output. This is a protocol failure; the implicit-question
    //        fallback must NOT apply (the model explicitly attempted to end the
    //        turn, so guessing an outcome would be unsafe).
    //      - undefined — no finish_turn call at all. Fall back to an implicit
    //        "question" if the last model message is text-only (no tool calls) —
    //        the model addressed the user without continuing work.
    const decoded = decodeFinishTurnOutcome(messages);
    const outcome = decoded === "question" || decoded === "completion"
      ? decoded
      : decoded === undefined && lastModelMessageIsTextOnly(messages)
      ? "question"
      : undefined;
    if (outcome === undefined) {
      await attemptTurnFailed(
        "agent.outcome",
        new Error(
          decoded === "failed"
            ? "agent loop ended with a failed or malformed finish_turn call"
            : "agent loop ended without a successful finish_turn call",
        ),
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
    } catch (error) {
      reportError("callback.turn_finished", error);
      // Terminal delivery failed. Never switch to `turn.failed`.
      Deno.exitCode = 1;
    }
  } finally {
    // Close all MCP connections on every exit path — success, failure, and
    // all early returns. `closeMcpConnections` is best-effort: individual
    // `close()` failures are logged but never throw, so cleanup never
    // interferes with the already-decided exit code or terminal callback.
    await closeMcpConnections(mcpConnections);
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

/** Decodes the `finish_turn` outcome from the returned native `Message[]`.
 * Walks backwards for the last `tool` message containing a `finish_turn` tool
 * result. Returns:
 *   - `"question"` | `"completion"` when the last `finish_turn` succeeded
 *     (`result.error === undefined` and `output.outcome` is valid).
 *   - `"failed"` when `finish_turn` was called but errored or produced a
 *     malformed output. This is a protocol failure — the caller must NOT apply
 *     the implicit-question fallback (the model explicitly attempted to end
 *     the turn).
 *   - `undefined` when no `finish_turn` call exists at all — the caller may
 *     then check {@link lastModelMessageIsTextOnly} for an implicit "question"
 *     fallback.
 * Mirrors `decodeFinishTurnOutcome` in `ai_api_fixture.ts` (T1). */
function decodeFinishTurnOutcome(
  messages: Message[],
): "question" | "completion" | "failed" | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "tool") continue;
    for (const content of message.contents) {
      if (!("toolResult" in content)) continue;
      const result = content as ToolResultContent;
      if (result.toolResult.name !== "finish_turn") continue;
      // Found the last finish_turn result (walking backwards from the end).
      // A failed or malformed finish_turn is a protocol failure, NOT an
      // absent call — the implicit-question fallback must not apply.
      if (result.toolResult.result.error !== undefined) {
        return "failed";
      }
      const output = result.toolResult.result.output as
        | { outcome?: "question" | "completion" }
        | undefined;
      if (output?.outcome === "question" || output?.outcome === "completion") {
        return output.outcome;
      }
      return "failed";
    }
  }
  return undefined;
}

/** Checks whether the **last message** in the returned `Message[]` is a
 * text-only model message (no tool calls). The `@huuma/ai` loop ends
 * naturally when the model emits a response with no tool calls, so the last
 * message of a no-`finish_turn` run is expected to be that model message.
 * When `agent.run` ends without an explicit `finish_turn` call, this shape is
 * treated as an implicit "question" — the model produced a response for the
 * user without continuing work.
 *
 * Only the last message is examined: a run that ends on a non-model message
 * (e.g. a tool result without `finish_turn`) is NOT treated as an implicit
 * question, even if an earlier model message was text-only. Such an ending is
 * abnormal and falls through to the protocol-failure path. Optional chaining
 * on `toolCalls` guards against a loosely-typed adapter omitting the field at
 * runtime. */
function lastModelMessageIsTextOnly(messages: Message[]): boolean {
  const last = messages.at(-1);
  return last?.role === "model" && !last.toolCalls?.length;
}
