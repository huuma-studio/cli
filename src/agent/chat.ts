import type { agent, Message, TextContent } from "@huuma/ai/agent";
import type { McpConnection } from "@huuma/ai/tools";
import { multiline } from "../input.ts";
import { CLEAR_LINE, dim, green, red, write } from "../terminal.ts";
import { closeMcpConnections } from "./mcp.ts";
import { sanitizeError } from "./managed/callback.ts";
import {
  productionRetryDeps,
  runWithRetries,
  type RetryDeps,
} from "./retry.ts";

/** The slice of the @huuma/ai agent the REPL drives. Derived from `agent`
 * with `Pick` so the `run` signature tracks @huuma/ai automatically, while
 * staying a plain object type that is trivial to fake in tests. */
export type Assistant = Pick<ReturnType<typeof agent>, "run">;

/** Options for {@link chat} and {@link respond} beyond the assistant and
 * prompt. */
export interface ChatOptions {
  /** Additional model-call attempts after the initial one when it fails
   * transiently (rate limit, 5xx, network blip — ADR 0010). `0` disables
   * retrying. From `--retries` (which caps the value at 10); defaults to 2. */
  retries?: number;
  /** Injectable timing sources for the retry loop. Defaults to
   * {@link productionRetryDeps}; tests inject recorders. */
  retryDeps?: RetryDeps;
}

/** Drives the agent: a single answer when `prompt` is non-empty (one-shot),
 * otherwise an interactive REPL until "exit"/"quit" or stdin closes. After
 * the REPL exits (normal exit, stdin close, or error), all open MCP
 * connections are closed via `closeMcpConnections` (best-effort — individual
 * `close()` failures are logged but never throw). */
export async function chat(
  assistant: Assistant,
  prompt = "",
  mcpConnections: McpConnection[] = [],
  options: ChatOptions = {},
): Promise<string> {
  try {
    return await chatInner(assistant, prompt, options);
  } finally {
    await closeMcpConnections(mcpConnections);
  }
}

/** The actual REPL/one-shot logic, separated so {@link chat} can wrap it in
 * a `try/finally` for MCP connection cleanup. */
async function chatInner(
  assistant: Assistant,
  prompt: string,
  options: ChatOptions,
): Promise<string> {
  const oneShot = prompt.trim();
  if (oneShot) {
    // A single turn: respond() already printed the answer, so we keep only its
    // ok flag for the exit code and thread no history forward. If this ever
    // grows into chained prompts, carry the returned messages between turns
    // like the REPL below does.
    const { ok } = await respond(assistant, oneShot, [], options);
    if (!ok) Deno.exitCode = 1;
    return "";
  }

  console.log(dim('\nType "exit" to quit.\n'));

  let messages: Message[] = [];
  while (true) {
    let prompt: string;
    try {
      // Multi-line composer: Enter sends, Shift+Enter / Ctrl+J add a new line.
      prompt = await multiline("You:", {
        validate: (value) =>
          value ? undefined : 'Type a message or "exit" to quit',
      });
    } catch {
      // stdin closed while waiting for input (non-tty)
      break;
    }

    if (prompt === "exit" || prompt === "quit") break;
    messages = (await respond(assistant, prompt, messages, options)).messages;
  }

  return "Bye!";
}

/** Outcome of a single turn: the conversation to carry forward — the new
 * messages when the model answered, the unchanged `history` when it failed so
 * a transient error doesn't wipe the chat — plus whether it answered. */
interface Turn {
  messages: Message[];
  ok: boolean;
}

export async function respond(
  assistant: Assistant,
  prompt: string,
  history: Message[],
  options: ChatOptions = {},
): Promise<Turn> {
  const retries = options.retries ?? 2;
  const retryDeps = options.retryDeps ?? productionRetryDeps;
  write(dim("Thinking..."));
  try {
    // Messages emitted during failed attempts, echo-free. A retry resumes
    // with them appended to the original history, so tool calls that already
    // executed appear as prior conversation and are not re-run (ADR 0010).
    const emitted: Message[] = [];
    const messages = await runWithRetries(
      async () => {
        let first = true;
        return await assistant.run(prompt, [...history, ...emitted], {
          onMessage: (message) => {
            showToolCalls(message);
            // Each attempt re-emits the triggering user message first;
            // dropping it keeps the retry history free of duplicate user
            // messages (the re-supplied prompt re-adds it).
            if (first && message.role === "user") {
              first = false;
              return;
            }
            first = false;
            emitted.push(message);
          },
        });
      },
      {
        retries,
        onRetry: ({ attempt, backoffMs, error }) => {
          write(CLEAR_LINE);
          console.error(
            dim(
              `retry ${attempt}/${retries} in ${Math.round(backoffMs)}ms — ${
                oneLine(sanitizeError(error))
              }`,
            ),
          );
          write(dim("Thinking..."));
        },
      },
      retryDeps,
    );
    write(CLEAR_LINE);
    console.log(`${green("Agent:")} ${modelText(messages)}\n`);
    return { messages, ok: true };
  } catch (error) {
    write(CLEAR_LINE);
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${red("✖")} ${red(message)}\n`);
    return { messages: history, ok: false };
  }
}

/** Flattens a sanitized error into a single line for the retry notice. */
function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").trim();
}

/** Prints the name of each tool the model calls, live as the run emits the
 * message, then restores the Thinking... indicator the names interrupted.
 * Sub-agent tools show up as one call (their name); the calls a sub-agent
 * makes internally run on a separate inner agent and are not emitted here. */
export function showToolCalls(message: Message): void {
  // Optional chaining although the type requires toolCalls: a loosely-typed
  // adapter can omit it at runtime, and the library guards the same way.
  if (message.role !== "model" || !message.toolCalls?.length) return;
  write(CLEAR_LINE);
  for (const { name } of message.toolCalls) {
    console.log(dim(`⚙ ${name}`));
  }
  write(dim("Thinking..."));
}

/** Extracts the text of the last model message that contains any. */
export function modelText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "model") continue;

    const text = message.contents
      .filter((content): content is TextContent => "text" in content)
      .map((content) => content.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "(no response)";
}
