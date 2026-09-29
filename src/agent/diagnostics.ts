import { envValue } from "./env.ts";
import { CallbackError, sanitizeError } from "./managed/callback.ts";
import type { LogContext, LogEntry } from "./managed/log_shipper.ts";

/** Receives structured, log-sanitized diagnostics — in managed mode, the
 * `--log-url` shipper's `send`. Must be synchronous; failures are swallowed by
 * the callers below. */
export type DiagnosticSink = (entry: LogEntry) => void;

/** Emits a sanitized agent diagnostic and returns the sanitized message.
 *
 * The scope and stage are deliberately separate from the thrown value so
 * operational logs identify the failing boundary without changing the error
 * text sent in managed callback payloads. The returned message always comes
 * from {@link sanitizeError}; the optional structured `sink` instead receives
 * the stricter {@link sanitizeDiagnostic} text. The console and structured
 * sinks are guarded independently: a broken diagnostic sink must never
 * interfere with command or managed-turn error handling, nor block the other.
 */
export function reportAgentError(
  scope: "agent" | "managed",
  stage: string,
  error: unknown,
  logError: (message: string) => void = console.error,
  sink?: DiagnosticSink,
  context?: LogContext,
): string {
  const message = sanitizeError(error);
  try {
    logError(`[${scope}:${stage}] ${message}`);
  } catch {
    // Diagnostics are best-effort and must not alter the agent lifecycle.
  }
  emitDiagnostic(sink, "error", scope, stage, error, context);
  return message;
}

/** Sends one structured diagnostic to `sink`, if any. Sanitizes with
 * {@link sanitizeDiagnostic}, adds `callback_kind` for callback failures, and
 * never throws. */
export function emitDiagnostic(
  sink: DiagnosticSink | undefined,
  level: LogEntry["level"],
  scope: "agent" | "managed",
  stage: string,
  error: unknown,
  context?: LogContext,
): void {
  if (sink === undefined) return;
  try {
    const kind = callbackKind(error);
    sink({
      level,
      message: sanitizeDiagnostic(error),
      scope,
      stage,
      context: kind === undefined
        ? context
        : { ...context, callback_kind: kind },
    });
  } catch {
    // Diagnostics are best-effort and must not alter the agent lifecycle.
  }
}

/** Message used when a diagnostic cannot be coerced or sanitized. */
export const UNAVAILABLE_DIAGNOSTIC = "diagnostic message unavailable";

/** Environment variables whose exact values are replaced in log output. An
 * explicit allowlist of the credentials the CLI itself reads — arbitrary
 * environment values are never enumerated. */
export const KNOWN_CREDENTIAL_ENV = [
  "HUUMA_AGENT_API_KEY",
  "HUUMA_AGENT_CALLBACK_SECRET",
  "HUUMA_SPECS_API_TOKEN",
  "BRAVE_API_KEY",
  "PERPLEXITY_API_KEY",
  "OLLAMA_SEARCH_API_KEY",
] as const;

/** Reads the current non-empty values of {@link KNOWN_CREDENTIAL_ENV}, without
 * triggering permission prompts. */
export function knownCredentialValues(): string[] {
  const values: string[] = [];
  for (const name of KNOWN_CREDENTIAL_ENV) {
    try {
      const value = envValue(name);
      if (value) values.push(value);
    } catch {
      // Unreadable env is simply not redacted by value.
    }
  }
  return values;
}

const REDACTED = "[redacted]";

/** Key names treated as credentials in assignments: token, password, secret,
 * credential(s), api key — in any case, with any `_`/`-` prefix or suffix
 * (`access_token`, `X-Api-Key`, `client-secret`, `HUUMA_SPECS_API_TOKEN`). */
const CREDENTIAL_KEY = String
  .raw`[A-Za-z0-9_-]*(?:token|passw(?:or)?d|secret|credentials?|api[_-]?key|apikey)[A-Za-z0-9_-]*`;

/** Credential assignments: query/form `key=value`, header-like `key: value`,
 * and JSON-style `"key": "value"` / `"key": 123` (the optional quote after the
 * key covers JSON keys). */
const ASSIGNMENT = new RegExp(
  String
    .raw`(\b${CREDENTIAL_KEY}['"]?\s*[=:]\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s&,;"'}\]]+)`,
  "gi",
);

/** Absolute URLs: `scheme://authority/path?query#fragment`. */
const URL_PATTERN = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>`]+/g;

/** Log-specific sanitizer for diagnostics that leave the sandbox via
 * `--log-url` (spec 111). Stricter than {@link sanitizeError}, which it applies
 * last for the existing heuristics and the 1,024-byte UTF-8 bound:
 *
 * 1. Exact non-empty values of the known credential env vars are replaced.
 * 2. URL userinfo, query strings, and fragments are removed.
 * 3. Credential assignments (JSON, query/form, header-like) are redacted,
 *    including short and punctuated values.
 *
 * Any failure (hostile `toString`/`message` getters, etc.) yields
 * {@link UNAVAILABLE_DIAGNOSTIC}. Redaction is defense in depth, not a
 * guarantee. Callback payloads keep using {@link sanitizeError}. */
export function sanitizeDiagnostic(
  error: unknown,
  knownValues: readonly string[] = knownCredentialValues(),
): string {
  try {
    const raw = error instanceof Error ? error.message : String(error);
    let text = typeof raw === "string" ? raw : String(raw);
    for (
      const value of [...knownValues].filter((v) => v.length > 0).sort((a, b) =>
        b.length - a.length
      )
    ) {
      text = text.split(value).join(REDACTED);
    }
    text = text
      .replace(URL_PATTERN, redactUrl)
      .replace(ASSIGNMENT, `$1${REDACTED}`);
    const sanitized = sanitizeError(text);
    return typeof sanitized === "string" ? sanitized : UNAVAILABLE_DIAGNOSTIC;
  } catch {
    return UNAVAILABLE_DIAGNOSTIC;
  }
}

/** Removes userinfo, query, and fragment from one URL token, textually (no
 * normalization, so the rest of the URL reads as it was written). */
function redactUrl(url: string): string {
  const schemeEnd = url.indexOf("://") + 3;
  let rest = url.slice(schemeEnd);
  const cut = rest.search(/[?#]/);
  const suffix = cut === -1 ? "" : `${rest[cut]}${REDACTED}`;
  if (cut !== -1) rest = rest.slice(0, cut);
  const authorityEnd = rest.search(/[/]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const at = authority.lastIndexOf("@");
  if (at !== -1) {
    rest = `${REDACTED}@${rest.slice(at + 1)}`;
  }
  return `${url.slice(0, schemeEnd)}${rest}${suffix}`;
}

function callbackKind(error: unknown): LogContext["callback_kind"] {
  return error instanceof CallbackError ? error.kind : undefined;
}
