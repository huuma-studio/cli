import { sanitizeError } from "./managed/callback.ts";

/** Emits a sanitized agent diagnostic and returns the sanitized message.
 *
 * The scope and stage are deliberately separate from the thrown value so
 * operational logs identify the failing boundary without changing the error
 * text sent in managed callback payloads. A broken diagnostic sink must never
 * interfere with command or managed-turn error handling.
 */
export function reportAgentError(
  scope: "agent" | "managed",
  stage: string,
  error: unknown,
  logError: (message: string) => void = console.error,
): string {
  const message = sanitizeError(error);
  try {
    logError(`[${scope}:${stage}] ${message}`);
  } catch {
    // Diagnostics are best-effort and must not alter the agent lifecycle.
  }
  return message;
}
