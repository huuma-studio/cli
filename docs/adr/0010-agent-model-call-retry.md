# Model-call retry with backoff for transient provider failures in `huuma agent`

Status: accepted

Model calls fail transiently all the time — rate limits, provider overload,
connection resets, timeouts. Before this ADR, a single such failure wasted the
whole `huuma agent` execution: in local mode a one-shot run exited 1 with the
error printed, and in managed turn mode the Turn went to
`attemptTurnFailed("agent.run", …)` with the only recovery being Studio's
whole-Turn `awaiting_retry` re-run — far heavier than re-calling the model
once a second later.

## Decision

The CLI retries **whole `assistant.run()` invocations** over a shared retry
core in `src/agent/retry.ts`, used by both agent modes.

### Classification

`classifyModelError(error)` sorts a thrown failure into `"transient"` or
`"permanent"` by message text, because providers surface plain `Error`s
without status codes:

| Message pattern (case-insensitive)                                                  | Class     |
| ----------------------------------------------------------------------------------- | --------- |
| `rate limit`, `429`, `408`, `5xx` (`/\b5\d\d\b/`), `overload`, `timeout`/`timed out`, `connection reset`, `ECONNRESET`/`ECONNREFUSED`, `ETIMEDOUT`, `fetch failed`, `socket hang up`, `network` | transient |
| `401`, `403`, `unauthorized`, `forbidden`, `invalid api key`, `invalid request`, `api key`, `permission` | permanent |
| `CallbackError` (any kind)                                                           | permanent |
| `ProtocolError` (the managed runner's first-emission mismatch)                        | permanent |
| anything else (unknown)                                                              | transient |

Transient patterns are checked before permanent ones: a rate-limit message
that happens to mention an api key is still a rate limit, and the contract's
bias is toward retrying. **Unknown errors classify as transient** — attempts
are bounded (see below), so a wasted retry is cheaper than an avoidable
failure.

Two failures are never retried regardless of their text:

- **`CallbackError`** — a callback *delivery* failure, not a model failure.
  Retrying `run()` would re-drive the callback path; delivery has its own
  deadline-aware retry loop.
- **The first-emission protocol failure** — the managed runner throws
  `ProtocolError` when the first message emitted by `agent.run` does not
  match the triggering user message. The mismatch is deterministic; a retry
  would repeat it.

### Retry loop

`runWithRetries(fn, { retries, cutoffMs?, onRetry? }, deps)` performs at most
`retries` additional attempts after the initial call, retrying only transient
errors. Backoff is `min(5_000, 250 × 2^attempt)` ms scaled by the same
`[0.5, 1.0)` jitter factor callback delivery uses
(`base × (0.5 + random() × 0.5)`); the constants are shared with
`src/agent/managed/callback.ts`. A permanent error short-circuits
immediately with the original error; exhaustion rethrows the last error
unchanged, so every caller's existing failure path (sanitized error display,
`turn.failed`, exit code) is identical to an un-retried run.

All timing flows through injected `now`/`sleep`/`random` sources
(`RetryDeps`), mirroring `CallbackDeps` minus `fetch`, so tests are fully
deterministic with fake recorders.

When `cutoffMs` is set, no retry attempt starts at or after it (checked both
before committing to the backoff sleep and after it, since the sleep may
consume the remaining budget).

### Configuration: `--retries <n>`, flag only

Per ADRs 0006 and 0007, behavioral configuration lives in flags — never env
vars. Process argv is the one supply channel a tooled agent cannot mutate
mid-run; an env var for retry behavior could be persisted by the agent itself
and silently change every future run.

`--retries <n>` is the number of **additional attempts after the initial
call**. Default **2**; `--retries 0` disables retrying. It is validated as a
non-negative integer at parse time, accepted in both space and `=` forms like
every value flag, valid in both local and managed mode (a shared option, like
`--model`), and documented in `huuma agent --help`. Setup failures (bad
flags, missing credentials) stay fail-fast — retrying never masks a
configuration error.

### Local chat (`respond()`)

`assistant.run` is wrapped in `runWithRetries`. The retry **resumes, it does
not restart**: messages emitted during a failed attempt (observed through the
existing `onMessage` hook) are accumulated, and the next attempt is passed
`history = original history + emitted messages minus the re-emitted
triggering user message`, so tool calls that already executed appear as prior
conversation and are not re-run. Each retry prints a dim, single-line notice
(attempt count, backoff, sanitized reason) using `sanitizeError`. After
exhaustion the behavior is unchanged: error line, history preserved,
`ok: false`, exit 1 in one-shot mode.

### Managed turn mode (`runManagedTurn`)

The retry wraps the `agent.run` call. The "agent loop runs exactly once per
Turn" invariant is **amended**: `agent.run` may be re-invoked after a
transient model failure, but the callback contract is preserved on every
attempt —

- **Single terminal event**: retries do not touch the terminal machinery; on
  exhausted retries the existing `attemptTurnFailed("agent.run", …)` path
  runs unchanged (at most one terminal event, exit 1).
- **Monotonic `turn_sequence`**: `turnSequence` is not reset between
  attempts. Already-acknowledged `message.appended` events keep their
  numbers; new messages continue monotonically from the delivered prefix.
- **Echo suppression**: `firstEmission` is re-armed at the start of each
  attempt, so the re-emitted triggering user message is re-suppressed and
  Studio keeps owning sequence 0 — no duplicate echo is delivered.
- **Never re-drive callbacks**: `CallbackError` delivery failures and the
  first-emission protocol failure are classified permanent by
  `classifyModelError` and follow their existing paths (auth-stop, conflict,
  fatal-failable turn.failed) unchanged.
- **Deadline-aware**: no retry attempt starts when less than
  `TERMINAL_RESERVE_MS` (15 s) remains before `--turn-deadline`
  (`cutoffMs = turnDeadline − TERMINAL_RESERVE_MS`), mirroring the
  non-terminal callback delivery cutoff, so the final 15 seconds stay
  reserved for terminal delivery. Retry timing reuses the injected
  `CallbackDeps` sources, keeping tests deterministic.

Studio's whole-Turn `awaiting_retry` re-run (spec #27) remains the outer
safety net for non-transient and exhausted failures.

## Consequences

- `src/agent/retry.ts` exports `classifyModelError`, `runWithRetries`,
  `RetryDeps`/`productionRetryDeps`, `ProtocolError`, and the
  `BACKOFF_BASE_MS`/`BACKOFF_CAP_MS` constants. `TERMINAL_RESERVE_MS` is now
  exported from `managed/callback.ts` so the retry cutoff shares the reserve.
- `chat()`/`respond()` accept `{ retries, retryDeps }`; `agent.ts` threads
  the parsed flag through. `ManagedConfig` gains a `retries` field threaded
  from `parseAgentArgs` via `resolveManagedConfig`.
- The unknown-flag error, `--help`, and the parser's validation all name
  `--retries`.
- Tests: classification table and deterministic backoff sequencing in
  `retry_test.ts`; fake-Assistant retry/resume/exhaustion/notice tests in
  `chat_test.ts`; retry-then-finished, mid-loop resume, exhaustion,
  permanent-failure, and deadline-cutoff tests in `runner_test.ts` (existing
  runner/integration tests pin `retries: 0` so today's no-retry paths stay
  covered); parser coverage in `args_test.ts`.
- Out of scope (future): retrying inside `@huuma/ai` (per-HTTP-call retry,
  streaming resumption), configurable backoff base/cap/jitter, provider/model
  fallback, and Studio-side changes.

## Alternatives considered

- **Retrying inside `@huuma/ai`.** Rejected for v1 — the CLI can only wrap
  whole `run()` invocations; a per-HTTP-call retry or streaming resumption
  belongs in the library and would not cover sub-agent inner loops either.
- **Retrying tool calls or setup failures.** Rejected — tool calls are
  deterministic commands whose re-execution may be unsafe, and setup
  failures (bad flags, missing keys) are deterministic configuration errors;
  both stay fail-fast.
- **Env-var configuration** (`HUUMA_AGENT_RETRIES`). Rejected per the ADR
  0006/0007 argument above.
- **Configurable backoff constants.** Rejected for v1 — the callback
  delivery constants (250 ms base, 5 s cap, `[0.5, 1.0)` jitter) are already
  proven; pinning them keeps the surface at one flag.
- **Falling back to a different provider/model** after repeated failures.
  Deferred — a different provider means different tools, costs, and output
  conventions; a separate ADR should own that.