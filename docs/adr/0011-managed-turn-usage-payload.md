# ADR 0011: Optional managed-turn usage payloads

- Status: Accepted
- Date: 2026-09-24

## Context

Managed-turn callbacks currently report lifecycle state and native `@huuma/ai`
messages, but not the resources used to produce them. `@huuma/ai` exposes an
accumulated `ModelUsage` snapshot to its `onMessage` callback, and the runner
can sample its own CPU and memory at message-emission boundaries.

The callback endpoint is versioned by compatibility rather than by a URL or an
explicit schema-version field. Existing Studio deployments and older runners
must continue to interoperate during a coordinated rollout.

## Decision

Schema version 1 adds an optional top-level `usage` field to `message.appended`
and `turn.finished`. `turn.running` and `turn.failed` are unchanged. Every
section inside `usage` is optional; unavailable telemetry is omitted rather than
guessed.

### `message.appended`

```json
{
  "run_id": "…",
  "turn_id": "…",
  "event": "message.appended",
  "turn_sequence": 3,
  "message": { "role": "model", "contents": [] },
  "usage": {
    "tokens": {
      "model": "claude-sonnet-4-5",
      "inputTokens": 812,
      "outputTokens": 240,
      "thinkingTokens": 0,
      "cacheReadInputTokens": 1024,
      "cacheWriteInputTokens": 0,
      "totalTokens": 1052
    },
    "cpu": {
      "userMs": 830,
      "systemMs": 210,
      "totalMs": 1040
    },
    "ram": {
      "rssBytes": 104857600,
      "heapUsedBytes": 41943040,
      "peakRssBytes": 130023424
    }
  }
}
```

- `tokens` is the delta between the accumulated usage snapshot accompanying this
  message and the previous snapshot in the same `agent.run` attempt. It is
  normally present on the first model message emitted for a model call and
  absent on tool messages. Fields not reported by the provider remain absent.
- `model` is the configured model identifier and is omitted when unknown.
- `cpu` is process CPU consumed since the previous emitted message, or since
  `turn.running` for the first emitted message. It contains user, system, and
  total milliseconds. Linux clock ticks are converted using the host's
  `AT_CLKTCK` auxiliary-vector value, and the counters include reaped children.
- `ram` is sampled at emission time. `peakRssBytes` is the highest RSS observed
  at an emission boundary during the Turn; it is not a continuously monitored
  process peak.

The triggering user-message echo is suppressed and therefore produces no
`message.appended` callback or usage payload.

### `turn.finished`

```json
{
  "run_id": "…",
  "turn_id": "…",
  "event": "turn.finished",
  "outcome": "completion",
  "usage": {
    "tokens": {
      "model": "claude-sonnet-4-5",
      "inputTokens": 1600,
      "outputTokens": 420,
      "totalTokens": 2020
    },
    "cpu": {
      "userMs": 1700,
      "systemMs": 300,
      "totalMs": 2000
    },
    "ram": {
      "peakRssBytes": 130023424
    }
  }
}
```

The terminal summary contains token totals across all model-run attempts in the
Turn, cumulative CPU since `turn.running`, and the Turn-scoped sampled peak RSS.
`turn.failed` intentionally carries no usage summary.

## Delivery and retry semantics

`CallbackReporter` treats `usage` as opaque callback data. It serializes each
event once and reuses the same bytes for every HTTP retry; usage does not alter
idempotency keys, response classification, backoff, or deadlines.

A `message.appended` body remains strictly below 1 MB. When its message needs
truncation, the encoded usage size is reserved as part of the immutable
envelope. Only `message` is reduced; `usage` is preserved verbatim.

For an in-Turn model retry, the token-delta baseline resets because each
`agent.run` attempt starts a new accumulated snapshot. Turn token totals include
the final observed snapshot from every attempt. CPU counters and sampled peak
RSS remain Turn-scoped and continue across attempts.

## Failure handling

Telemetry is best-effort. Each resource sample has a 25 ms deadline; a failure
or timeout is logged through the managed runner's sanitized diagnostic path and
omits only that section. Sampling therefore adds at most that bounded delay and
never prevents, modifies, or fails message delivery. The reporter itself does
not validate or transform supplied usage.

## Compatibility and rollout

Absence is the compatibility mechanism:

- Older runners send no `usage`; Studio accepts and persists that as null.
- New runners omit unavailable sections rather than sending fabricated zeros.
- Additive optional fields may be introduced in a future compatible schema.
  Removing fields, changing units, or making an optional field required needs a
  new ADR and a coordinated protocol revision.

Rollout order is strict because callback `400` responses are fatal to a managed
Turn:

1. Deploy Studio callback acceptance and persistence.
2. Release the CLI that emits usage.
3. Update Studio's pinned CLI version.

## Consequences

Usage data is stored outside native message JSON so Studio redaction of keys
such as `token` cannot corrupt token counts. Sampling only at emission
boundaries keeps overhead low but does not measure whole-sandbox resources or
peaks between samples.
