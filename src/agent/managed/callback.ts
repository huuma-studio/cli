/**
 * Protocol boundary for managed-turn callback delivery (ADR 0007).
 *
 * {@link CallbackReporter} emits the four managed-turn event kinds
 * (`turn.running`, `message.appended`, `turn.finished`, `turn.failed`) to one
 * fixed callback URL with strict delivery semantics:
 *
 * - Sequential and ordered: each event method awaits its acknowledgement
 *   before returning. There is no background queue; the caller (T5) is
 *   responsible for calling methods in order.
 * - Stable retry request: the JSON body bytes and `Idempotency-Key` header
 *   are constructed once per event and reused verbatim for every retry.
 * - Bounded bodies: `message.appended` bodies are kept strictly under 1 MB
 *   (`MAX_MESSAGE_BODY_BYTES`); oversized messages are shrunk to valid JSON
 *   before the body bytes are built.
 * - Deadline-aware retries: exponential backoff with jitter, capped at 5 s,
 *   honoring `Retry-After` only when it does not extend beyond the applicable
 *   cutoff. Non-terminal events retry until `turnDeadline - 15_000` ms;
 *   terminal events retry until `turnDeadline` itself.
 * - Response classification per ADR 0007's response contract table.
 *
 * The reporter takes injectable sources (`fetch`, `now`, `sleep`, `random`)
 * so retry behavior is fully deterministic in tests. It does not import from
 * `config.ts`; callers pass plain constructor args. It never logs and never
 * exposes response bodies or secrets.
 */

/** A minimal HTTP response shape: status code plus an optional header lookup
 * for `Retry-After`. The reporter never reads the response body. */
export interface ResponseLike {
  readonly status: number;
  readonly headers?: { get(name: string): string | null };
}

/** Per-attempt POST request init. The reporter computes `timeoutMs` and passes
 * it to the injected `fetch`, which is responsible for enforcing it (e.g. via
 * `AbortSignal.timeout`). The reporter does not abort in-flight requests. */
export interface CallbackFetchInit {
  method: "POST";
  headers: Record<string, string>;
  body: Uint8Array;
  /** Per-attempt timeout in milliseconds: `min(10_000, remaining_before_cutoff)`. */
  timeoutMs: number;
}

/** Injectable sources. All retry behavior is a pure function of these inputs,
 * so tests can reproduce every retry sequence deterministically. */
export interface CallbackDeps {
  /** Posts bytes to a URL with the given headers. Returns the response.
   * A thrown error is treated as a transient network failure. */
  fetch: (url: string, init: CallbackFetchInit) => Promise<ResponseLike>;
  /** Returns the current time. Used for deadline and retry calculations. */
  now: () => Date;
  /** Sleeps for the given milliseconds. Tests inject a no-op or recorder. */
  sleep: (ms: number) => Promise<void>;
  /** Returns a uniform random number in `[0, 1)` for jitter. */
  random: () => number;
}

/** The discriminant carried by every {@link CallbackError}. It survives
 * propagation through `onMessageError: "throw"` so T5 can decide whether
 * `turn.failed` is permitted after a non-terminal delivery failure. */
export type CallbackErrorKind =
  /** `401` or `403` — invalid/revoked credential or closed Turn. Stop
   * immediately; never attempt `turn.failed`. */
  | "auth-stop"
  /** `409` — idempotency conflict. Fatal; never duplicate-success. */
  | "conflict"
  /** `202`, other unexpected `2xx`, `400`, `413`, and any other permanent
   * `4xx` (except `401`/`403`/`408`/`409`/`429`). Fatal, but `turn.failed` is
   * permitted when the failing event was non-terminal. */
  | "fatal-failable"
  /** Transient retries (`408`, `429`, `5xx`, network failure) exhausted within
   * the deadline budget. `turn.failed` is permitted. */
  | "budget-exhausted";

/** Thrown by {@link CallbackReporter} for every non-success outcome. The
 * `kind` field tells T5 whether to attempt `turn.failed`, stop entirely, or
 * exit non-zero after a failed terminal delivery. Error messages never
 * include the callback secret or response bodies — only the idempotency key
 * (derived from the Turn ID) and the HTTP status. */
export class CallbackError extends Error {
  readonly kind: CallbackErrorKind;
  constructor(kind: CallbackErrorKind, message: string) {
    super(message);
    this.name = "CallbackError";
    this.kind = kind;
  }
}

/** The final 15 seconds before `--turn-deadline` are reserved for
 * `turn.failed` delivery (PLAN, "Reserve terminal-delivery time").
 * Non-terminal events retry only until `turnDeadline - TERMINAL_RESERVE_MS`.
 * Exported so the model-call retry loop (ADR 0010) applies the same reserve:
 * no `agent.run` retry starts inside the terminal window. */
export const TERMINAL_RESERVE_MS = 15_000;
/** Each HTTP attempt times out after at most 10 s, reduced when less time
 * remains before the applicable cutoff. */
const MAX_ATTEMPT_TIMEOUT_MS = 10_000;
/** `turn.failed` error strings are truncated to at most 1024 UTF-8 bytes
 * without splitting a code point. */
const MAX_ERROR_BYTES = 1024;
/** `message.appended` bodies are kept strictly under 10^6 UTF-8 bytes —
 * under 1 MB whether that is counted decimally or as 1 MiB (2^20). The
 * endpoint rejects larger bodies with 413, which the delivery contract
 * classifies as fatal, so one oversized message would fail the whole Turn.
 * When a body reaches the cap the message value itself is shrunk (see
 * {@link truncateMessageForBody}); the envelope fields (`run_id`, `turn_id`,
 * `event`, `turn_sequence`) are never touched. Exported so tests can pin
 * the cap. */
export const MAX_MESSAGE_BODY_BYTES = 1_000_000;
/** Exponential backoff base. */
const BACKOFF_BASE_MS = 250;
/** Exponential backoff cap. */
const BACKOFF_CAP_MS = 5_000;

export interface CallbackReporterOptions {
  /** Absolute http/https URL the reporter POSTs every event to. Never appended
   * to. */
  callbackUrl: string;
  /** Per-turn callback secret. Used only to set `Authorization: Bearer <secret>`. */
  callbackSecret: string;
  /** Studio Run ID, repeated in every body. */
  runId: string;
  /** Studio Turn ID. The idempotency key is derived from this. */
  turnId: string;
  /** Parsed `--turn-deadline`. Non-terminal events retry until 15 s before it;
   * terminal events retry until the deadline itself. */
  turnDeadline: Date;
  /** Injectable sources for deterministic retry behavior. */
  deps: CallbackDeps;
}

/** Reports managed-turn events to a single fixed callback URL with the
 * delivery semantics defined in ADR 0007. Construct one per Turn. */
export class CallbackReporter {
  private readonly callbackUrl: string;
  private readonly callbackSecret: string;
  private readonly runId: string;
  private readonly turnId: string;
  private readonly turnDeadlineMs: number;
  private readonly deps: CallbackDeps;

  constructor(opts: CallbackReporterOptions) {
    this.callbackUrl = opts.callbackUrl;
    this.callbackSecret = opts.callbackSecret;
    this.runId = opts.runId;
    this.turnId = opts.turnId;
    this.turnDeadlineMs = opts.turnDeadline.getTime();
    this.deps = opts.deps;
  }

  /** POSTs `turn.running` (sent once after the Agent is initialized). */
  async turnRunning(): Promise<void> {
    const body = this.encodeBody({
      run_id: this.runId,
      turn_id: this.turnId,
      event: "turn.running",
    });
    await this.deliver(`${this.turnId}:turn.running`, body, false);
  }

  /** POSTs `message.appended` for one native `@huuma/ai` message.
   * `turnSequence` is a positive integer starting at 1 (sequence 0 is
   * reserved for the app-persisted triggering user message).
   *
   * Messages that fit are posted verbatim. When the encoded body would reach
   * {@link MAX_MESSAGE_BODY_BYTES}, the message is first shrunk to valid JSON
   * via {@link truncateMessageForBody} — Studio rejects larger bodies with
   * 413, a fatal outcome. The shrink is deterministic, so body bytes remain
   * stable across retries. */
  async messageAppended(turnSequence: number, message: unknown): Promise<void> {
    if (!Number.isInteger(turnSequence) || turnSequence < 1) {
      throw new Error(
        `turn_sequence must be a positive integer starting at 1; received ${
          String(turnSequence)
        }`,
      );
    }
    const plain = {
      run_id: this.runId,
      turn_id: this.turnId,
      event: "message.appended",
      turn_sequence: turnSequence,
      message,
    };
    let body = this.encodeBody(plain);
    if (body.byteLength >= MAX_MESSAGE_BODY_BYTES) {
      // Reserve the envelope's share of the cap. The `{}` placeholder stands
      // in for the message so the measurement matches the final body's key
      // order; the 2 bytes it under-counts are a safety margin.
      const overhead = jsonByteLength({ ...plain, message: {} });
      body = this.encodeBody({
        ...plain,
        message: truncateMessageForBody(
          message,
          MAX_MESSAGE_BODY_BYTES - overhead,
        ),
      });
    }
    await this.deliver(
      `${this.turnId}:message.appended:${turnSequence}`,
      body,
      false,
    );
  }

  /** POSTs `turn.finished` with the `finish_turn` outcome. Shares the terminal
   * idempotency key with `turn.failed` so contradictory terminals cannot both
   * win. Valid only after every emitted message has been acknowledged. */
  async turnFinished(outcome: "question" | "completion"): Promise<void> {
    const body = this.encodeBody({
      run_id: this.runId,
      turn_id: this.turnId,
      event: "turn.finished",
      outcome,
    });
    await this.deliver(`${this.turnId}:terminal`, body, true);
  }

  /** POSTs `turn.failed` with a sanitized, truncated error string. The caller
   * should build `error` via {@link sanitizeError}; the reporter truncates it
   * defensively to `MAX_ERROR_BYTES` UTF-8 bytes. */
  async turnFailed(error: string): Promise<void> {
    const body = this.encodeBody({
      run_id: this.runId,
      turn_id: this.turnId,
      event: "turn.failed",
      error: truncateUtf8Bytes(error, MAX_ERROR_BYTES),
    });
    await this.deliver(`${this.turnId}:terminal`, body, true);
  }

  /** Delivers one event with stable body bytes and idempotency key across
   * retries, classifying each response per ADR 0007's response contract. */
  private async deliver(
    idempotencyKey: string,
    body: Uint8Array,
    terminal: boolean,
  ): Promise<void> {
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.callbackSecret}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    };
    const cutoff = terminal
      ? this.turnDeadlineMs
      : this.turnDeadlineMs - TERMINAL_RESERVE_MS;

    let attempt = 0;
    while (true) {
      // Per-attempt budget check. The first attempt is allowed only if time
      // remains; after a transient failure this guards against retrying past
      // the cutoff.
      const now = this.deps.now().getTime();
      const remaining = cutoff - now;
      if (remaining <= 0) {
        throw new CallbackError(
          "budget-exhausted",
          `callback deadline budget exhausted for event ${idempotencyKey} ` +
            `after ${attempt} attempt(s)`,
        );
      }
      const timeoutMs = Math.min(MAX_ATTEMPT_TIMEOUT_MS, remaining);

      let response: ResponseLike;
      try {
        response = await this.deps.fetch(this.callbackUrl, {
          method: "POST",
          headers,
          body,
          timeoutMs,
        });
      } catch {
        // Network failure is transient (ADR 0007 response contract). There is
        // no response to inspect; fall through to the retry path.
        await this.retryAfterTransient(idempotencyKey, attempt, null, cutoff);
        attempt += 1;
        continue;
      }

      switch (classify(response.status)) {
        case "success":
          return;
        case "auth-stop":
          throw new CallbackError(
            "auth-stop",
            `callback rejected ${idempotencyKey} with ${response.status} ` +
              `(authentication/authorization failure)`,
          );
        case "conflict":
          throw new CallbackError(
            "conflict",
            `callback rejected ${idempotencyKey} with 409 ` +
              `(idempotency conflict)`,
          );
        case "fatal-failable":
          throw new CallbackError(
            "fatal-failable",
            `callback rejected ${idempotencyKey} with ${response.status} ` +
              `(permanent failure)`,
          );
        case "transient":
          await this.retryAfterTransient(
            idempotencyKey,
            attempt,
            response,
            cutoff,
          );
          attempt += 1;
          continue;
      }
    }
  }

  /** Computes and sleeps the backoff before the next retry attempt.
   *
   * Backoff formula:
   * `backoff = min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2^attempt) * (0.5 + random() * 0.5)`
   *
   * The jitter factor is in `[0.5, 1.0)`, so the actual sleep is between half
   * and all of the base backoff. `Retry-After` (parsed as integer seconds) is
   * honored only when `now + retryAfter <= cutoff`; otherwise the computed
   * backoff is used. If the chosen sleep would push the next attempt past the
   * cutoff, the retry budget is exhausted and we throw rather than sleeping
   * past the deadline. */
  private async retryAfterTransient(
    idempotencyKey: string,
    attempt: number,
    response: ResponseLike | null,
    cutoff: number,
  ): Promise<void> {
    const now = this.deps.now().getTime();
    const remaining = cutoff - now;
    if (remaining <= 0) {
      throw new CallbackError(
        "budget-exhausted",
        `callback deadline budget exhausted for ${idempotencyKey}`,
      );
    }
    const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
    let sleepMs = base * (0.5 + this.deps.random() * 0.5);
    const retryAfter = response ? parseRetryAfterMs(response) : null;
    if (retryAfter !== null && now + retryAfter <= cutoff) {
      sleepMs = retryAfter;
    }
    if (now + sleepMs > cutoff) {
      throw new CallbackError(
        "budget-exhausted",
        `callback deadline budget exhausted for ${idempotencyKey} ` +
          `(next retry would exceed cutoff)`,
      );
    }
    await this.deps.sleep(sleepMs);
  }

  /** Encodes a JSON body to a stable `Uint8Array` of UTF-8 bytes. Called once
   * per event; the same bytes are reused across every retry. */
  private encodeBody(body: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(body));
  }
}

/** Classifies an HTTP status per ADR 0007's response contract. */
function classify(
  status: number,
): "success" | "auth-stop" | "conflict" | "fatal-failable" | "transient" {
  if (status === 200 || status === 201 || status === 204) return "success";
  if (status === 401 || status === 403) return "auth-stop";
  if (status === 409) return "conflict";
  if (status === 408 || status === 429) return "transient";
  if (status >= 500 && status < 600) return "transient";
  if (status >= 200 && status < 300) return "fatal-failable"; // 202, 206, other 2xx
  if (status >= 400 && status < 500) return "fatal-failable"; // 400, 413, 404, 422, …
  // 1xx, 3xx, 6xx+: Studio never sends these under the contract. Treat as
  // transient so a stray redirect or informational response does not become a
  // silent permanent failure; the retry budget bounds the wasted attempts.
  return "transient";
}

/** Parses `Retry-After` as integer seconds → milliseconds. Only the integer
 * form is honored; the HTTP-date form is not (clock skew plus the runner's
 * deadline budget make it rare and non-deterministic). Returns `null` for
 * absent or unparseable values. */
function parseRetryAfterMs(response: ResponseLike): number | null {
  const raw = response.headers?.get("Retry-After");
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1000;
}

/** Truncates `s` to at most `maxBytes` UTF-8 bytes without splitting a code
 * point. The cut walks backward from `maxBytes` past any continuation bytes
 * (`10xxxxxx`) to land on a leading byte boundary, so the returned string is
 * always valid UTF-8. Used for the `turn.failed` error payload and by
 * {@link sanitizeError}. */
export function truncateUtf8Bytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = new TextEncoder().encode(s);
  if (bytes.byteLength <= maxBytes) return s;
  let cut = maxBytes;
  // Skip trailing continuation bytes (high bit pattern 10xxxxxx) so the cut
  // lands on a leading byte boundary.
  while (cut > 0 && (bytes[cut]! & 0xC0) === 0x80) cut--;
  return new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.subarray(0, cut),
  );
}

/** Marker appended to every string value shortened by message-body
 * truncation. ASCII-only, so the marker itself never grows under UTF-8. */
const MESSAGE_TRUNCATION_MARKER = "...[truncated]";
const MESSAGE_TRUNCATION_MARKER_BYTES = MESSAGE_TRUNCATION_MARKER.length;
/** Upper bound for the first per-string budget used by
 * {@link truncateMessageForBody}: strings longer than this are cut on the
 * first pass; the budget halves on every later pass until the encoded body
 * fits, so the largest strings give way first and roles, keys, and
 * identifiers survive. */
const MAX_STRING_BUDGET_BYTES = 262_144;

const utf8 = new TextEncoder();

/** Byte length of `JSON.stringify(value)`. `undefined` serializes to nothing
 * and counts as empty. */
function jsonByteLength(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : utf8.encode(json).byteLength;
}

/** Shrinks a message value so the encoded `message.appended` body stays
 * within `maxMessageBytes`, keeping the result valid JSON:
 *
 * 1. Values that already fit pass through untouched.
 * 2. Otherwise strings longer than a per-string budget are cut to the budget
 *    on a code point boundary (via {@link truncateUtf8Bytes}) and marked with
 *    `...[truncated]`. The budget starts just below the longest string
 *    (capped at {@link MAX_STRING_BUDGET_BYTES}) and halves until the body
 *    fits. A string is only cut when that actually shrinks it — one barely
 *    over the budget would grow once the marker is appended.
 * 3. The budget-1 candidate is the floor of step 2: every cut string is then
 *    down to the 1-byte cut plus the marker. When even the floor does not
 *    fit (very many small strings), step 2 is skipped entirely and the
 *    message collapses to a preview placeholder — the original role (when
 *    present) plus the serialized original, truncated, as `contents`.
 *
 * The original message is serialized exactly once and shared by every
 * measurement and the fallback, so pathological values pay one clone walk
 * plus one encode before giving up on structural truncation. Deterministic:
 * the same message always yields the same result, so body bytes stay stable
 * across callback retries. */
export function truncateMessageForBody(
  message: unknown,
  maxMessageBytes: number,
): unknown {
  // Serialize the original once; the JSON string feeds the measurements here
  // and the preview fallback, which never re-stringifies the message.
  const originalJson = JSON.stringify(message) ?? "";
  const originalSize = utf8.encode(originalJson).byteLength;
  if (originalSize <= maxMessageBytes) return message;
  // Measure the floor candidate first. For every budget b >= 1 each string's
  // serialized contribution is at least its contribution at budget 1, so a
  // floor that does not fit proves no per-string budget can help.
  const floorState = { cut: false };
  const floorCandidate = truncateLongStrings(message, 1, floorState);
  const floorSize = floorState.cut
    ? jsonByteLength(floorCandidate)
    : originalSize;
  if (floorSize > maxMessageBytes) {
    return previewPlaceholder(message, originalJson, maxMessageBytes);
  }
  // A pass cuts only when some string exceeds budget + marker, so start just
  // below the longest string value (keys are never cut) and cap the start at
  // MAX_STRING_BUDGET_BYTES to keep the first cut meaningful.
  let budget = Math.min(
    MAX_STRING_BUDGET_BYTES,
    Math.max(1, maxStringBytes(message) - MESSAGE_TRUNCATION_MARKER_BYTES - 1),
  );
  while (budget > 1) {
    const state = { cut: false };
    const candidate = truncateLongStrings(message, budget, state);
    // When nothing was cut the candidate is identical to the input — reuse
    // the already-known original size instead of re-encoding it.
    const size = state.cut ? jsonByteLength(candidate) : originalSize;
    if (size <= maxMessageBytes) return candidate;
    budget = Math.floor(budget / 2);
  }
  // Budget 1 is the already-measured floor candidate.
  return floorCandidate;
}

/** Longest UTF-8 byte length among string values in `value` (keys excluded —
 * they are never cut). Allocation-free walk used to pick the first per-string
 * budget. Returns 0 when there are no string values. */
function maxStringBytes(value: unknown): number {
  if (typeof value === "string") return utf8.encode(value).byteLength;
  if (Array.isArray(value)) {
    let max = 0;
    for (const item of value) {
      max = Math.max(max, maxStringBytes(item));
    }
    return max;
  }
  if (value !== null && typeof value === "object") {
    let max = 0;
    for (const member of Object.values(value as Record<string, unknown>)) {
      max = Math.max(max, maxStringBytes(member));
    }
    return max;
  }
  return 0;
}

/** Returns a copy of `value` where every string longer than `budget` UTF-8
 * bytes is cut to `budget` on a code point boundary and marked. Keys are
 * preserved verbatim; only string values shrink. Sets `state.cut` when at
 * least one string was shortened, so the caller can skip re-encoding an
 * unchanged candidate. */
function truncateLongStrings(
  value: unknown,
  budget: number,
  state: { cut: boolean },
): unknown {
  if (typeof value === "string") {
    const bytes = utf8.encode(value).byteLength;
    if (bytes <= budget + MESSAGE_TRUNCATION_MARKER_BYTES) return value;
    state.cut = true;
    return truncateUtf8Bytes(value, budget) + MESSAGE_TRUNCATION_MARKER;
  }
  if (Array.isArray(value)) {
    return value.map((item) => truncateLongStrings(item, budget, state));
  }
  if (value !== null && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (
      const [key, member] of Object.entries(value as Record<string, unknown>)
    ) {
      copy[key] = truncateLongStrings(member, budget, state);
    }
    return copy;
  }
  return value;
}

/** Builds the preview placeholder for values that cannot fit under any
 * per-string budget. `source` is the caller's single JSON serialization of
 * the original message; it is cut on a code point boundary and halved until
 * the placeholder itself fits — never re-stringified. It is embedded as a
 * JSON string value, so a cut mid-escape cannot corrupt the body — the
 * outer JSON stays valid regardless. */
function previewPlaceholder(
  message: unknown,
  source: string,
  maxMessageBytes: number,
): unknown {
  const record = typeof message === "object" && message !== null
    ? message as { role?: unknown }
    : undefined;
  const role = typeof record?.role === "string" ? record.role : undefined;
  let previewBytes = Math.max(maxMessageBytes, 0);
  while (true) {
    const preview = truncateUtf8Bytes(source, previewBytes) +
      MESSAGE_TRUNCATION_MARKER;
    const placeholder = role === undefined
      ? { contents: preview }
      : { role, contents: preview };
    if (jsonByteLength(placeholder) <= maxMessageBytes || previewBytes <= 0) {
      return placeholder;
    }
    previewBytes = Math.floor(previewBytes / 2);
  }
}

/**
 * Sanitizes a thrown value into a `turn.failed` error string that is safe to
 * send to the callback endpoint. Used by T5 to build the `turn.failed` payload.
 *
 * Heuristic, applied in order:
 *  1. Coerce to a string (`Error.message` for `Error`s, `String(value)`
 *     otherwise).
 *  2. Strip `Authorization:` header lines entirely (case-insensitive,
 *     multiline) so bearer secrets do not leak.
 *  3. Replace `Bearer <token>` with `Bearer [redacted]`.
 *  4. Replace `sk-<alphanumeric>` (provider key prefixes like OpenAI's) with
 *     `sk-[redacted]`.
 *  5. Replace `api_key=<value>` with `api_key=[redacted]` (query-string / form).
 *  6. Replace any run of ≥20 ASCII alphanumeric characters with
 *     `[redacted]`. This catches hex digests, base64url tokens, JWT segments,
 *     and similar credential-looking strings. Underscores, hyphens, dots, and
 *     slashes break runs, so ordinary file paths and snake_case identifiers
 *     are not redacted as a side effect.
 *  7. Collapse the blank lines left by stripped Authorization headers.
 *  8. Truncate to `MAX_ERROR_BYTES` (1024) UTF-8 bytes on a code point
 *     boundary.
 *
 * This is intentionally conservative: a false positive (redacting a long but
 * non-secret identifier) is preferable to leaking a credential into a
 * `turn.failed` payload or logs.
 */
export function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncateUtf8Bytes(redact(message), MAX_ERROR_BYTES);
}

function redact(s: string): string {
  return s
    // 2. Strip Authorization header lines entirely.
    .replace(/^\s*Authorization:.*$/gim, "")
    // 3. Bearer tokens.
    .replace(/(Bearer\s+)[A-Za-z0-9._\-+/=]+/gi, "$1[redacted]")
    // 4. Provider API-key prefixes such as OpenAI's "sk-...".
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
    // 5. Query-string / form api_key values.
    .replace(/(api_key=)[^\s&]+/gi, "$1[redacted]")
    // 6. Long alphanumeric runs (hex digests, base64url tokens, JWT segments).
    .replace(/[A-Za-z0-9]{20,}/g, "[redacted]")
    // 7. Collapse blank lines left by stripped Authorization headers.
    .replace(/\n{2,}/g, "\n")
    .trim();
}
