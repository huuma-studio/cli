/**
 * Fire-and-forget diagnostic log shipping for managed turn mode (spec 111).
 *
 * The managed runner's stdout/stderr are discarded inside the Studio Turn
 * sandbox, so `--log-url` lets it additionally POST each sanitized diagnostic
 * to a debug-only log sink. Logging exists to give insight, not to be
 * reliable:
 *
 * - {@link LogShipper.send} is synchronous, never throws, and is never awaited
 *   on the Turn path. Serialization, fetch, timeout, and response-cleanup
 *   failures are swallowed.
 * - Each request carries a {@link LOG_REQUEST_TIMEOUT_MS} abort signal and
 *   rejects redirects. The response body is cancelled as soon as headers
 *   arrive; the status is ignored.
 * - At most {@link MAX_IN_FLIGHT} requests are in flight; further entries are
 *   dropped immediately. There is no queue, retry, or flush, so the process
 *   exits at most one request timeout after its last send.
 *
 * Messages must already be sanitized by the caller (`sanitizeDiagnostic`);
 * the shipper only enforces the size bounds and the typed context allowlist.
 */
import { isUuid } from "./config.ts";
import { MAX_ERROR_BYTES, truncateUtf8Bytes } from "./callback.ts";

/** Per-request deadline. Bounds the delay a pending send adds to process
 * exit. */
export const LOG_REQUEST_TIMEOUT_MS = 2_000;
/** Maximum concurrent requests per runner; excess entries are dropped. */
export const MAX_IN_FLIGHT = 4;
/** Code-point bound for the short metadata fields (source, version, scope,
 * stage), matching the log endpoint. */
export const MAX_METADATA_CHARS = 128;
/** Value of the `source` field on every entry. */
export const LOG_SOURCE = "huuma-cli";

export type LogLevel = "error" | "warn" | "info" | "debug";

/** Callback failure kinds, mirroring `CallbackError.kind`. */
export type LogCallbackKind =
  | "auth-stop"
  | "conflict"
  | "fatal-failable"
  | "budget-exhausted";

/** The typed context allowlist. Anything else is dropped before sending. */
export interface LogContext {
  /** Model-call retry attempt (1–11). */
  attempt?: number;
  /** Kind of the callback failure being reported. */
  callback_kind?: LogCallbackKind;
  /** Exit code the process is about to report. */
  exit_code?: 0 | 1;
}

/** One diagnostic as produced by the CLI. The shipper adds source, version,
 * Run/Turn IDs, and the timestamp. */
export interface LogEntry {
  level: LogLevel;
  /** Sanitized diagnostic text; bounded to 1,024 UTF-8 bytes on send. */
  message: string;
  /** Static scope from code, e.g. `managed`. */
  scope?: string;
  /** Static stage from code, e.g. `agent.run`. Never raw argv. */
  stage?: string;
  context?: LogContext;
}

export interface LogShipper {
  /** Starts sending `entry` in the background. Synchronous; never throws. */
  send(entry: LogEntry): void;
}

export interface LogShipperOptions {
  /** Log sink URL. Undefined yields a no-op shipper. */
  url: URL | undefined;
  /** Run ID; omitted from entries unless it is a valid UUID. */
  runId?: string;
  /** Turn ID; omitted from entries unless it is a valid UUID. */
  turnId?: string;
  sourceVersion: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Injectable for tests. Defaults to `new Date()`. */
  now?: () => Date;
  /** Injectable for tests. Defaults to {@link LOG_REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
}

const NOOP_SHIPPER: LogShipper = { send: () => {} };

const CALLBACK_KINDS: ReadonlySet<string> = new Set<LogCallbackKind>([
  "auth-stop",
  "conflict",
  "fatal-failable",
  "budget-exhausted",
]);

const LOG_LEVELS: ReadonlySet<string> = new Set<LogLevel>([
  "error",
  "warn",
  "info",
  "debug",
]);

/** Creates a {@link LogShipper}; a no-op when `options.url` is undefined. */
export function createLogShipper(options: LogShipperOptions): LogShipper {
  const { url } = options;
  if (url === undefined) return NOOP_SHIPPER;
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? LOG_REQUEST_TIMEOUT_MS;
  const runId = validId(options.runId);
  const turnId = validId(options.turnId);
  const sourceVersion = boundMetadata(options.sourceVersion);
  let inFlight = 0;

  return {
    send(entry: LogEntry): void {
      try {
        if (inFlight >= MAX_IN_FLIGHT) return;
        const body = JSON.stringify(
          buildPayload(entry, { sourceVersion, runId, turnId, now }),
        );
        inFlight += 1;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          inFlight -= 1;
        };
        try {
          const signal = AbortSignal.timeout(timeoutMs);
          // Release on abort too, so a fetch that ignores its signal cannot
          // hold a slot forever.
          signal.addEventListener("abort", release, { once: true });
          Promise.resolve(fetchFn(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            redirect: "error",
            signal,
          }))
            .then(cancelBody, () => {})
            .finally(release)
            .catch(() => {});
        } catch {
          release();
        }
      } catch {
        // Logging is best-effort and must never alter the Turn.
      }
    },
  };
}

/** Cancels a response body as soon as headers arrive; ignores failures. */
async function cancelBody(response: Response): Promise<void> {
  try {
    await response?.body?.cancel();
  } catch {
    // Cleanup failures are irrelevant to the Turn.
  }
}

function buildPayload(
  entry: LogEntry,
  meta: {
    sourceVersion: string | undefined;
    runId: string | undefined;
    turnId: string | undefined;
    now: () => Date;
  },
): Record<string, unknown> {
  const level = LOG_LEVELS.has(entry.level) ? entry.level : "error";
  const message = truncateUtf8Bytes(String(entry.message), MAX_ERROR_BYTES) ||
    "(empty diagnostic)";
  const payload: Record<string, unknown> = {
    level,
    message,
    source: LOG_SOURCE,
  };
  if (meta.sourceVersion) payload.source_version = meta.sourceVersion;
  const scope = boundMetadata(entry.scope);
  if (scope) payload.scope = scope;
  const stage = boundMetadata(entry.stage);
  if (stage) payload.stage = stage;
  if (meta.runId) payload.run_id = meta.runId;
  if (meta.turnId) payload.turn_id = meta.turnId;
  const occurredAt = timestamp(meta.now);
  if (occurredAt) payload.occurred_at = occurredAt;
  const context = projectContext(entry.context);
  if (context) payload.context = context;
  return payload;
}

/** Keeps only the typed, allow-listed context keys with valid values. */
export function projectContext(
  context: LogContext | undefined,
): LogContext | undefined {
  if (context === undefined || context === null) return undefined;
  const projected: LogContext = {};
  const { attempt, callback_kind, exit_code } = context;
  if (Number.isInteger(attempt) && attempt! >= 1 && attempt! <= 11) {
    projected.attempt = attempt;
  }
  if (typeof callback_kind === "string" && CALLBACK_KINDS.has(callback_kind)) {
    projected.callback_kind = callback_kind;
  }
  if (exit_code === 0 || exit_code === 1) projected.exit_code = exit_code;
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function boundMetadata(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const chars = Array.from(value);
  return chars.length <= MAX_METADATA_CHARS
    ? value
    : chars.slice(0, MAX_METADATA_CHARS).join("");
}

function validId(value: string | undefined): string | undefined {
  return typeof value === "string" && isUuid(value) ? value : undefined;
}

/** `Date.toISOString()` output for years 0001–9999, the only form the log
 * endpoint accepts. Extended years (`+010000-…`) and year 0000 are rejected
 * there together with the whole entry, so they are omitted here instead. */
const ISO_TIMESTAMP = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function timestamp(now: () => Date): string | undefined {
  try {
    const value = now().toISOString();
    return ISO_TIMESTAMP.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
