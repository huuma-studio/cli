import type { agent, Message, TextContent } from "@huuma/ai/agent";
import { multiline } from "../input.ts";
import { CLEAR_LINE, dim, green, red, write } from "../terminal.ts";

/** The slice of the @huuma/ai agent the REPL drives. Derived from `agent`
 * with `Pick` so the `run` signature tracks @huuma/ai automatically, while
 * staying a plain object type that is trivial to fake in tests. */
export type Assistant = Pick<ReturnType<typeof agent>, "run">;

/** Drives the agent: a single answer when `prompt` is non-empty (one-shot),
 * otherwise an interactive REPL until "exit"/"quit" or stdin closes. */
export async function chat(
  assistant: Assistant,
  prompt = "",
): Promise<string> {
  const oneShot = prompt.trim();
  if (oneShot) {
    // A single turn: respond() already printed the answer, so we keep only its
    // ok flag for the exit code and thread no history forward. If this ever
    // grows into chained prompts, carry the returned messages between turns
    // like the REPL below does.
    const { ok } = await respond(assistant, oneShot, []);
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
    messages = (await respond(assistant, prompt, messages)).messages;
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
): Promise<Turn> {
  write(dim("Thinking..."));
  try {
    const messages = await assistant.run(prompt, history);
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
