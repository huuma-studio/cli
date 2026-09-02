/**
 * Shared model-call retry core for `huuma agent` (ADR 0010).
 *
 * Model calls fail transiently all the time — rate limits, provider overload,
 * connection resets. Providers surface plain `Error`s without status codes
 * and `@huuma/ai` performs no retry of its own, so the CLI retries whole
 * `assistant.run()` invocations: {@link classifyModelError} decides from the
 * error text whether a failure is worth retrying, and {@link runWithRetries}
 * bounds the additional attempts with exponential backoff and jitter.
 *
 * The backoff constants and jitter factor are shared with managed callback
 * delivery (`src/agent/managed/callback.ts`), and the injectable
 * `now`/`sleep`/`random` sources mirror `CallbackDeps` so tests are fully
 * deterministic.
 */
import { CallbackError } from "./managed/callback.ts";

/** Exponential backoff base — shared with callback delivery. */
export const BACKOFF_BASE_MS = 250;
/** Exponential backoff cap — shared with callback delivery. */
export const BACKOFF_CAP_MS = 5_000;

/** Thrown by the managed runner when the first message emitted by `agent.run`
 * fails the first-emission verification (role or contents do not match the
 * triggering user message). The failure is deterministic — retrying would
 * repeat it — so {@link classifyModelError} always classifies it permanent. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

/** Injectable timing sources for {@link runWithRetries}, mirroring
 * `CallbackDeps` minus `fetch` (model retry performs no HTTP of its own). */
export interface RetryDeps {
  /** Returns the current time. Used for deadline-cutoff checks. */
  now: () => Date;
  /** Sleeps for the given milliseconds. Tests inject a recorder. */
  sleep: (ms: number) => Promise<void>;
  /** Returns a uniform random number in `[0, 1)` for jitter. */
  random: () => number;
}

/** Production timing sources. */
export const productionRetryDeps: RetryDeps = {
  now: () => new Date(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

/** Whether a model-call failure is worth retrying. */
export type ModelFailureKind = "transient" | "permanent";

// Transient patterns are checked before the permanent ones: a rate-limit
// message that happens to mention an api key is still a rate limit, and the
// bias of this contract is toward retrying (unknown errors lean transient
// anyway — attempts are bounded, so a wasted retry is cheaper than an
// avoidable failure).
const TRANSIENT_RE = new RegExp(
  [
    "rate[\\s_-]?limit",
    "\\b429\\b",
    "\\b408\\b",
    "\\b5\\d\\d\\b",
    "\\b5xx\\b",
    "overload",
    "time[\\s_-]?out",
    "timed?[\\s_-]?out",
    "connection[\\s_-]?reset",
    "econnreset",
    "econnrefused",
    "etimedout",
    "fetch[\\s_-]?failed",
    "socket[\\s_-]?hang[\\s_-]?up",
    "network",
  ].join("|"),
  "i",
);

const PERMANENT_RE = new RegExp(
  [
    "\\b401\\b",
    "\\b403\\b",
    "unauthorized",
    "forbidden",
    "invalid[\\s_-]?api[\\s_-]?key",
    "invalid[\\s_-]?request",
    "api[\\s_-]?key",
    "permission",
  ].join("|"),
  "i",
);

/** Classifies a thrown model-call failure by its message text (ADR 0010).
 *
 * Providers surface plain `Error`s without status codes, so the
 * classification is message-text heuristics: rate limit / 429 / 408 / 5xx /
 * overloaded / timeout / connection-reset / fetch-failed patterns are
 * transient; 401 / 403 / unauthorized / invalid-api-key / invalid-request
 * patterns are permanent. Unknown errors classify as transient — attempts
 * are bounded, so a wasted retry is cheaper than an avoidable failure.
 *
 * Two failures are never retried regardless of their text: `CallbackError`
 * (a callback *delivery* failure — retrying `run()` would re-drive the
 * callback path) and the managed runner's first-emission protocol failure
 * ({@link ProtocolError} — deterministic, it would repeat). */
export function classifyModelError(error: unknown): ModelFailureKind {
  if (error instanceof CallbackError || error instanceof ProtocolError) {
    return "permanent";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (TRANSIENT_RE.test(message)) return "transient";
  if (PERMANENT_RE.test(message)) return "permanent";
  return "transient";
}

/** Info passed to {@link RetryOptions.onRetry} before each retry attempt. */
export interface RetryNotice {
  /** 1-based retry number (1 = first retry after the initial attempt). */
  attempt: number;
  /** Milliseconds the loop sleeps before the next attempt. */
  backoffMs: number;
  /** The transient error that triggered the retry. */
  error: unknown;
}

export interface RetryOptions {
  /** Additional attempts after the initial call. `0` disables retrying. */
  retries: number;
  /** Epoch-ms cutoff: no retry attempt starts at or after it. The managed
   * runner passes `turnDeadline - TERMINAL_RESERVE_MS` so the final 15
   * seconds stay reserved for terminal callback delivery. */
  cutoffMs?: number;
  /** Called after a transient failure, once the next backoff is computed and
   * before the sleep. The local chat prints a sanitized notice from it. */
  onRetry?: (notice: RetryNotice) => void;
}

/** Runs `fn` with bounded retries over transient model failures (ADR 0010).
 *
 * `fn` is the single model-call invocation to protect. A transient failure
 * (per {@link classifyModelError}) is retried at most `retries` additional
 * times with backoff `min(BACKOFF_CAP_MS, BACKOFF_BASE_MS × 2^attempt)`
 * scaled by the same `[0.5, 1.0)` jitter factor callback delivery uses. A
 * permanent failure short-circuits immediately with the original error, and
 * exhaustion rethrows the last error unchanged — the caller's failure paths
 * are identical to an un-retried run. When `cutoffMs` is set, no retry
 * attempt starts at or after the cutoff (checked both before committing to
 * the backoff sleep and after it, since the sleep may consume the reserve). */
export async function runWithRetries<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
  deps: RetryDeps = productionRetryDeps,
): Promise<T> {
  const { retries, cutoffMs, onRetry } = options;
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (classifyModelError(error) === "permanent") throw error;
      if (attempt >= retries) throw error;
      if (cutoffMs !== undefined && deps.now().getTime() >= cutoffMs) {
        throw error;
      }
      const backoffMs = backoffForAttempt(attempt, deps.random());
      onRetry?.({ attempt: attempt + 1, backoffMs, error });
      await deps.sleep(backoffMs);
      if (cutoffMs !== undefined && deps.now().getTime() >= cutoffMs) {
        throw error;
      }
      attempt += 1;
    }
  }
}

/** `min(BACKOFF_CAP_MS, BACKOFF_BASE_MS × 2^attempt)` scaled by the same
 * `[0.5, 1.0)` jitter factor callback delivery uses. */
function backoffForAttempt(attempt: number, random: number): number {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return base * (0.5 + random * 0.5);
}