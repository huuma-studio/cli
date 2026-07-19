import type { ManagedAgentArgs, ModelSelection } from "../args.ts";
import { envValue } from "../env.ts";

/** The minimum number of milliseconds that must remain between the start of
 * managed turn mode and `--turn-deadline`. The final 15 seconds are reserved
 * for `turn.failed` delivery (PLAN, "Reserve terminal-delivery time"). */
export const MIN_DEADLINE_REMAINING_MS = 15_000;

/** Providers that host models behind a fixed endpoint and therefore require
 * `HUUMA_AGENT_API_KEY` in managed turn mode. Ollama is excluded: it runs
 * locally and only requires an explicit `--host`; the API key is optional for
 * unauthenticated hosts. */
const HOSTED_PROVIDERS = new Set(["anthropic", "openai", "google", "mistral"]);

/** The validated, atomic configuration for one managed turn. Built from a
 * {@link ManagedAgentArgs} by {@link resolveManagedConfig}; nothing here is
 * read from disk or asked interactively — T4 reads `--history`, T3 delivers
 * callback events.
 *
 * {@link ManagedConfig.callbackSecret} is the only sensitive field: it is the
 * per-turn secret from `$HUUMA_AGENT_CALLBACK_SECRET`. It must never be
 * logged, echoed, or included in an error message. {@link resolveManagedConfig}
 * fails before returning if it is missing, so a non-empty string here proves
 * the env var was set. T3's callback reporter is the sole consumer. */
export interface ManagedConfig {
  /** Absolute http/https URL the runner posts every event to. The runner
   * never appends event-specific paths (PLAN, "Callback contract"). */
  callbackUrl: URL;
  /** Studio UUID of the Run this Turn belongs to (from `--run-id`). */
  runId: string;
  /** Studio UUID of this Turn (from `--turn-id`). */
  turnId: string;
  /** Parsed `--turn-deadline` as a Date. At validation time at least
   * {@link MIN_DEADLINE_REMAINING_MS} remained before it. */
  turnDeadline: Date;
  /** Path to the JSON file holding the prior native `Message[]` history. T4
   * reads and shape-validates this (non-empty, ends with a user message). */
  historyPath: string;
  /** Working directory the Agent starts in (from `--cwd`). */
  cwd: string;
  /** Provider and model id. Always present in a valid {@link ManagedConfig};
   * the parser leaves it optional, the resolver enforces it. */
  model: ModelSelection;
  /** Ollama host when supplied via `--host`; undefined for hosted providers.
   * Provider-specific host rules are enforced here, not in the parser. */
  host: string | undefined;
  // Shared agent options (valid in both local and managed mode):
  tools: string[];
  cliCommands: string[];
  systemPrompt: string | undefined;
  searchEngine: string | undefined;
  skillsPath: string | undefined;
  /** SENSITIVE — per-turn callback secret from `$HUUMA_AGENT_CALLBACK_SECRET`.
   * Never log, print, or echo this value, and never include it in an error
   * message. T3 uses it once to set the `Authorization: Bearer` header;
   * nothing else should read it. */
  callbackSecret: string;
}

/** The atomic, non-interactive validator for managed turn mode. It checks the
 * complete flag group together and surfaces the first failure with a clean
 * error that names only the flag or variable responsible — never a secret
 * value.
 *
 * Validation order is deterministic: missing required flag → malformed Studio
 * UUID → invalid callback URL → invalid/too-soon `--turn-deadline` → missing
 * `HUUMA_AGENT_CALLBACK_SECRET` → missing provider credential / `--host`. The
 * function performs no I/O and never reads `--history` from disk; that is
 * T4's job. The {@link ManagedAgentArgs.prompt} field is enforced empty by the
 * parser, not re-checked here. */
export function resolveManagedConfig(parsed: ManagedAgentArgs): ManagedConfig {
  // 1. Required flags. --callback-url is present by construction (its presence
  //    is what selects managed mode), so the check covers --history, --cwd,
  //    --run-id, --turn-id, --turn-deadline, and --model.
  for (const [flag, value] of REQUIRED_FLAGS(parsed)) {
    if (value === undefined) {
      throw new Error(
        `${flag} is required in managed turn mode. All of --history, --cwd, ` +
          "--run-id, --turn-id, --turn-deadline, and --model must be supplied " +
          "together with --callback-url.",
      );
    }
  }
  const model = parsed.model;
  if (model === undefined) {
    throw new Error(
      "--model is required in managed turn mode. All of --history, --cwd, " +
        "--run-id, --turn-id, --turn-deadline, and --model must be supplied " +
        "together with --callback-url.",
    );
  }

  // 2. Studio UUIDs. Run and Turn IDs are opaque to the runner; we only check
  //    the canonical UUID shape. Errors include the received value because
  //    UUIDs are not secrets — this matches the existing --model error style.
  if (!isUuid(parsed.runId!)) {
    throw new Error(
      `--run-id must be a valid UUID. Received: ${parsed.runId}`,
    );
  }
  if (!isUuid(parsed.turnId!)) {
    throw new Error(
      `--turn-id must be a valid UUID. Received: ${parsed.turnId}`,
    );
  }

  // 3. Callback URL. Must parse as an absolute http/https URL.
  let callbackUrl: URL;
  try {
    callbackUrl = new URL(parsed.callbackUrl);
  } catch {
    throw new Error(
      `--callback-url must be a valid absolute http/https URL. Received: ` +
        `${parsed.callbackUrl}`,
    );
  }
  if (callbackUrl.protocol !== "http:" && callbackUrl.protocol !== "https:") {
    throw new Error(
      `--callback-url must be an http or https URL. Received: ` +
        `${parsed.callbackUrl}`,
    );
  }

  // 4. Turn deadline. Use Date.parse for RFC3339; require a finite timestamp
  //    and at least MIN_DEADLINE_REMAINING_MS remaining.
  const deadlineMs = Date.parse(parsed.turnDeadline!);
  if (!Number.isFinite(deadlineMs)) {
    throw new Error(
      `--turn-deadline must be a valid RFC3339 timestamp. Received: ` +
        `${parsed.turnDeadline}`,
    );
  }
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs < MIN_DEADLINE_REMAINING_MS) {
    throw new Error(
      `--turn-deadline must leave at least 15 seconds when managed turn mode ` +
        `starts. Received: ${parsed.turnDeadline}`,
    );
  }

  // 5. Callback secret. Read from the environment; never echo it back. The
  //    error names only the variable.
  const callbackSecret = envValue("HUUMA_AGENT_CALLBACK_SECRET");
  if (!callbackSecret) {
    throw new Error(
      "HUUMA_AGENT_CALLBACK_SECRET is required in managed turn mode and must " +
        "be non-empty.",
    );
  }

  // 6. Provider-specific credential / host. Hosted providers require
  //    HUUMA_AGENT_API_KEY; ollama requires an explicit --host and treats the
  //    API key as optional. An unknown provider is a configuration error here
  //    rather than waiting for setup (managed mode never prompts).
  const { provider } = model;
  if (HOSTED_PROVIDERS.has(provider)) {
    const apiKey = envValue("HUUMA_AGENT_API_KEY");
    if (!apiKey) {
      throw new Error(
        `HUUMA_AGENT_API_KEY is required in managed turn mode for the ` +
          `"${provider}" provider.`,
      );
    }
  } else if (provider === "ollama") {
    if (parsed.host === undefined) {
      throw new Error(
        "--host is required in managed turn mode for the ollama provider.",
      );
    }
  } else {
    throw new Error(
      `Unknown provider "${provider}". Managed turn mode requires --model ` +
        "with one of: anthropic, openai, google, mistral, ollama.",
    );
  }

  return {
    callbackUrl,
    runId: parsed.runId!,
    turnId: parsed.turnId!,
    turnDeadline: new Date(deadlineMs),
    historyPath: parsed.history!,
    cwd: parsed.cwd!,
    model,
    host: parsed.host,
    tools: parsed.tools,
    cliCommands: parsed.cliCommands,
    systemPrompt: parsed.systemPrompt,
    searchEngine: parsed.searchEngine,
    skillsPath: parsed.skillsPath,
    callbackSecret,
  };
}

/** Required-together flag/value pairs in the canonical validation order. The
 * `--model` flag is checked separately because its parsed value is a structured
 * `ModelSelection`, not a string. */
function REQUIRED_FLAGS(parsed: ManagedAgentArgs): ReadonlyArray<
  readonly [string, string | undefined]
> {
  return [
    ["--history", parsed.history],
    ["--cwd", parsed.cwd],
    ["--run-id", parsed.runId],
    ["--turn-id", parsed.turnId],
    ["--turn-deadline", parsed.turnDeadline],
  ];
}

/** Validates a Studio UUID (RFC 4122 form). The regex is the simple lowercase
 * form, applied case-insensitively so uppercase hex digits also pass. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
