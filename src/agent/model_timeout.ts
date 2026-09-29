/** Deadline for a single model call, in milliseconds — applied to every agent
 * the CLI builds (local, managed, and preset sub-agents) via @huuma/ai's
 * `modelTimeout`. A provider that accepts the request but never responds
 * would otherwise hold the run forever: Google, Mistral, and Ollama apply no
 * timeout of their own. Expiry rejects the run with a `TimeoutError`, which
 * the retry core classifies transient, so `--retries` still applies. */
export const MODEL_TIMEOUT_MS = 10 * 60 * 1000;
