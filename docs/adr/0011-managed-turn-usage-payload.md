# Managed-turn usage payload — token, CPU, and RAM reporting on callbacks

Status: accepted

Every message a managed runner returns to Huuma Studio should arrive with a
usage report: the model-call token usage attributable to that message, plus
the runner process's CPU and RAM consumption. Before this ADR the
`message.appended` callback carried only the native `@huuma/ai` message JSON —
the Studio could show what the agent said, but not what it cost. `@huuma/ai`
(0.2.6) already normalizes provider token usage into `ModelUsage` and passes a
run-accumulated snapshot to the `OnMessage` callback as its second argument;
the managed runner ignored it.

## Decision

`message.appended` gains an optional top-level `usage` field beside `message`,
and `turn.finished` gains an optional Turn usage summary. `turn.failed`
carries no usage, and `turn.running` never has.

### Schema (v1)

```json
{
  "run_id": "…",
  "turn_id": "…",
  "event": "message.appended",
  "turn_sequence": 3,
  "message": { "role": "model", "contents": [ … ] },
  "usage": {
    "tokens": {
      "model": "claude-haiku-4-5",
      "inputTokens": 812, "outputTokens": 240, "thinkingTokens": 0,
      "cacheReadInputTokens": 1024, "cacheWriteInputTokens": 0, "totalTokens": 1052
    },
    "cpu": { "userMs": 830, "systemMs": 210, "totalMs": 1040 },
    "ram": { "rssBytes": 104857600, "heapUsedBytes": 41943040, "peakRssBytes": 130023424 }
  }
}
```

- **tokens** — usage attributable to this message: the delta between the
  accumulated snapshot passed with this message and the one passed with the
  previous emission, plus the `model` identifier used for the call (for later
  cost computation), omitted when the runner cannot determine it. Present on
  model messages that follow a model call; absent on tool messages (no model
  call) and on the suppressed triggering user message (which sends no callback
  at all). If one model call emits several messages in a batch, the delta
  lands on the first; the rest carry no `tokens` — an unchanged accumulated
  snapshot means no model call happened in between. Absent fields mean "not
  reported", not zero.
- **cpu** — CPU milliseconds consumed by the runner process (self + reaped
  children, `/proc/self/stat` `utime`+`stime`+`cutime`+`cstime` at
  CLK_TCK = 100) since the previous emitted message of this Turn, or since
  `turn.running` for the first. Absent when `/proc` is unavailable (macOS dev).
- **ram** — gauges sampled at emission: current `rssBytes`/`heapUsedBytes`
  from `Deno.memoryUsage()`, plus `peakRssBytes`, the Turn-scoped maximum of
  the emission samples (not a continuous monitor).
- **turn.finished summary** — Turn-total `tokens` (every retry attempt's
  final snapshot summed), cumulative `cpu` since `turn.running`, and final
  `peakRssBytes`.

The `usage` field is schema-versioned as **v1**. Sections and fields may be
ADDED in a future version (consumers must ignore unknown sections and keys);
known sections and fields may never be repurposed or have their types changed —
a v2 that needs different semantics must use new names.

### Retry interaction (ADR 0010)

`agent.run` may be re-invoked after a transient model failure. Two rules keep
the attribution honest:

- The accumulated snapshot resets to `undefined` on every re-invoked
  `agent.run` attempt, so the token-delta baseline resets per attempt: the
  first message of an attempt carries that attempt's whole usage so far. The
  Turn-level accumulator sums every attempt's final snapshot for the
  `turn.finished` summary — tokens billed on a failed attempt whose messages
  were delivered still count.
- CPU counters are monotone, so the per-message delta baseline simply
  continues across attempts; the peak RSS stays Turn-scoped.

### Fail-safe telemetry

Collection is best-effort at every layer. Sampling happens only at emission
points, keeping overhead negligible; a sampling failure is logged and only the
affected section is omitted — never replaced with an incorrect value.
Telemetry must never block, delay, or corrupt message delivery: composition
runs inline before each `message.appended`, cannot throw, and the resulting
field is just another part of the per-event body bytes.

## Compatibility

- Idempotency keys, body-byte stability (bytes are still constructed once per
  event), retry/backoff, and the ADR 0007 response classification are
  untouched — `usage` is just another field of the per-event body.
- Every part of `usage` is optional at the protocol level. A runner that
  cannot sample omits the section; an older runner omits the field entirely;
  the Studio tolerates absence everywhere.
- The Studio boots the runner at a pinned version (`deno x jsr:@huuma/cli@…`)
  and a `400` from the callback is fatal to the runner. Rollout order is
  therefore strict: (1) deploy the Studio callback acceptance, (2) release the
  CLI with reporting, (3) bump the Studio-pinned CLI version. Under this
  order no runner ever sends `usage` to a Studio that would reject it.

## Out of scope (v1)

- Whole-sandbox (cgroup) accounting: live child processes (MCP stdio servers
  close only at Turn end) and non-runner sandbox memory. v1 measures the
  runner process plus reaped children.
- Continuous background CPU/RAM sampling for a true peak between emissions.
- Local `huuma agent` (interactive/one-shot) usage display in the terminal.
- Cost/pricing estimates and billing.
- `turn.failed` usage payloads and analytics beyond run-detail display.
- CPU utilization percentage — a meaningful percentage would need the
  continuous sampler excluded above; v1 reports attributable absolute CPU
  milliseconds per message.
- Network and GPU metrics.

## Consequences

- `src/agent/managed/usage.ts` exports the payload types
  (`MessageUsage`/`TurnUsageSummary`/`UsageTokens`/`UsageCpu`/`UsageRam`), the
  Turn-scoped `UsageTracker`, and `productionUsageDeps` (injectable
  `UsageDeps`: `readCpu`/`readRam`/`logError`) so tests stay deterministic.
- `CallbackReporter.messageAppended` accepts an optional third `usage`
  argument serialized verbatim beside `message`; `turnFinished` accepts an
  optional Turn summary. `turnFailed` is unchanged.
- `runManagedTurn` accepts the second `OnMessage` argument, wires the tracker
  (baseline at the acknowledged `turn.running`), resets the attempt baseline
  per re-invoked `agent.run`, and attaches the summary to `turn.finished`.
  The local `Assistant` type (`src/agent/chat.ts`) derives from `@huuma/ai`
  and needed no change.
- The Studio persists the payload beside the message JSON (never inside it)
  and displays per-message, per-Turn, and per-Run figures.

## Alternatives considered

- **Storing usage inside the message JSON.** Rejected — the message is the
  native `@huuma/ai` payload; telemetry is a different concern and the
  Studio's redaction walk would make the combination fragile.
- **A continuous background sampler.** Rejected for v1 — a timer that never
  blocks delivery is easy to get subtly wrong, and emission-point sampling
  already attributes costs to the right message.
- **Per-HTTP-call retry attribution inside `@huuma/ai`.** Rejected — the
  library reports provider usage per call; retry orchestration and its
  attribution belong to the runner (ADR 0010).