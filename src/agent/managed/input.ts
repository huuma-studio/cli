/**
 * Managed-turn history loading and validation (T4).
 *
 * {@link loadManagedInput} reads the native `Message[]` JSON file named by
 * `--history`, shape-validates it, and splits the triggering final user
 * message into the `agent.run` prompt plus the preceding `history` argument —
 * exactly the pattern pinned by PLAN.md "Inputs":
 *
 * ```ts
 * const triggeringMessage = messages.at(-1);
 * const prompt = triggeringMessage.contents;
 * const history = messages.slice(0, -1);
 * ```
 *
 * The runner validates the persisted shape but "does not filter, repair, or
 * truncate the persisted transcript" (PLAN, "Inputs"). Content parts are not
 * deeply validated; `@huuma/ai` validates further at run time. The function
 * does NOT change the process working directory — relative `--history` paths
 * resolve against the CLI invocation cwd, not `--cwd`. The caller (T5) calls
 * this before `managedSetup` chdirs.
 *
 * Errors are clean, human-readable, and name only the `--history` flag and the
 * problem. They never include file contents or secrets.
 */
import type {
  FileContent,
  Message,
  TextContent,
  UserMessage,
} from "@huuma/ai/agent";
import type { ManagedConfig } from "./config.ts";

/** The split managed-turn input: the triggering user message's `contents`
 * become the `agent.run` prompt (a string or a text/file part array — exactly
 * the {@link UserMessage.contents} shape), and every preceding message is the
 * `history` argument, preserved verbatim with no field rewriting. */
export interface ManagedInput {
  prompt: string | (TextContent | FileContent)[];
  history: Message[];
}

/** The only `MessageRole` values the persisted transcript may carry. A
 * narrowly-allowed role keeps the validation error precise without deeply
 * inspecting content parts. */
const ROLES = new Set(["system", "user", "model", "tool"]);

/** Reads and validates `config.historyPath`, then splits the resulting native
 * `Message[]` into the {@link ManagedInput} for `agent.run(prompt, history, …)`.
 *
 * Validation order: file readable → valid JSON → non-empty array → each entry
 * is an object with a valid `role` and a `contents` property → final entry is
 * a `user` message. The split is lossless: `prompt` is the final message's
 * `contents` (string or `(TextContent | FileContent)[]`, matching
 * `agent.run`'s prompt parameter), and `history` is every preceding message
 * unchanged. */
export async function loadManagedInput(
  config: ManagedConfig,
): Promise<ManagedInput> {
  const path = config.historyPath;
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`--history file is unreadable: ${path}: ${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`--history file is not valid JSON: ${path}: ${reason}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `--history must be a non-empty array of messages. Received ${
        describeNonArray(parsed)
      }.`,
    );
  }
  if (parsed.length === 0) {
    throw new Error("--history must be a non-empty array of messages.");
  }

  for (let i = 0; i < parsed.length; i++) {
    validateEntry(parsed[i], i);
  }

  // `parsed` is a non-empty array of role-tagged objects after the loop; cast
  // through `unknown` so the element type widens to `Message` without a per-
  // element assertion that would also widen bad shapes.
  const messages = parsed as unknown as Message[];
  const triggering = messages.at(-1)!;
  if (triggering.role !== "user") {
    throw new Error(
      `--history must end with a user message (the triggering message for ` +
        `this turn); the final message has role "${triggering.role}".`,
    );
  }
  const prompt = (triggering as UserMessage).contents;
  const history = messages.slice(0, -1);
  return { prompt, history };
}

/** Validates one entry of the persisted array: must be an object with a
 * `role` of `system | user | model | tool` and a `contents` property. Throws
 * a clean `--history[i] …` error naming the index and the problem. Content
 * parts are NOT deeply validated — `@huuma/ai` validates further at run time
 * (PLAN, "Inputs"). */
function validateEntry(entry: unknown, index: number): void {
  if (entry === null || typeof entry !== "object") {
    throw new Error(
      `--history[${index}] is not a message object. Received ${
        describeNonArray(entry)
      }.`,
    );
  }
  const obj = entry as Record<string, unknown>;
  if (!("role" in obj)) {
    throw new Error(`--history[${index}] is missing a role.`);
  }
  const role = obj.role;
  if (typeof role !== "string" || !ROLES.has(role)) {
    throw new Error(
      `--history[${index}] has invalid role ${JSON.stringify(role)}.`,
    );
  }
  if (!("contents" in obj)) {
    throw new Error(`--history[${index}] is missing contents.`);
  }
}

/** Short human-readable description of a non-array JSON value, for the
 * "must be a non-empty array" error. Mirrors the style of the flag-level
 * errors: names the kind, never the value (a value could be large or
 * sensitive). */
function describeNonArray(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}
