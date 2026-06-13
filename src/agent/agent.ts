import { agent, type Message, type TextContent } from "@huuma/ai/agent";
import { openai } from "@huuma/ai/models/openai";
import { ollama } from "@huuma/ai/models/ollama";
import { anthropic } from "@huuma/ai/models/anthropic";
import { choose, question } from "../input.ts";
import { CLEAR_LINE, dim, green, red, write } from "../terminal.ts";

/** The slice of the @huuma/ai agent the REPL drives. Derived from `agent`
 * with `Pick` so the `run` signature tracks @huuma/ai automatically, while
 * staying a plain object type that is trivial to fake in tests. */
export type Assistant = Pick<ReturnType<typeof agent>, "run">;

const SYSTEM_PROMPT =
  "You are Huuma Agent, a helpful assistant running in a terminal. " +
  "Answer concisely in plain text without markdown formatting.";

export default async (args: string[] = []) => {
  let messages: Message[] = [];
  const assistant = await setup();

  const oneShot = args.join(" ").trim();
  if (oneShot) {
    await respond(assistant, oneShot, messages);
    return "";
  }

  console.log(dim('\nType "exit" to quit.\n'));

  while (true) {
    let prompt: string;
    try {
      prompt = await question("You:", {
        validate: (value) =>
          value ? undefined : 'Type a message or "exit" to quit',
      });
    } catch {
      // stdin closed while waiting for input (non-tty)
      break;
    }

    if (prompt === "exit" || prompt === "quit") break;
    messages = await respond(assistant, prompt, messages);
  }

  return "Bye!";
};

async function setup(): Promise<Assistant> {
  const provider = await choose(
    [
      { label: "anthropic", description: "Anthropic API" },
      { label: "openai", description: "OpenAI or any OpenAI-compatible API" },
      { label: "ollama", description: "Local models running via Ollama" },
    ],
    "Select a model provider:",
  );

  if (provider === "anthropic") {
    const apiKey = envValue("ANTHROPIC_API_KEY") ??
      await question("Anthropic API key:", {
        validate: (value) => value ? undefined : "API key is required",
      });
    const modelId = await question("Model:", { default: "claude-haiku-4-5" });

    return agent({
      model: anthropic({ apiKey }),
      modelId,
      systemPrompt: SYSTEM_PROMPT,
    });
  }

  if (provider === "openai") {
    const apiKey = envValue("OPENAI_API_KEY") ??
      await question("OpenAI API key:", {
        validate: (value) => value ? undefined : "API key is required",
      });
    const modelId = await question("Model:", { default: "gpt-4o-mini" });

    return agent({
      model: openai({ apiKey }),
      modelId,
      systemPrompt: SYSTEM_PROMPT,
    });
  }

  const host = await question("Ollama host:", {
    default: "http://localhost:11434",
  });
  const modelId = await question("Model:", { default: "llama3.2" });

  return agent({
    model: ollama({ host }),
    modelId,
    systemPrompt: SYSTEM_PROMPT,
  });
}

function envValue(variable: string): string | undefined {
  const { state } = Deno.permissions.querySync({ name: "env", variable });
  return state === "granted" ? Deno.env.get(variable) : undefined;
}

export async function respond(
  assistant: Assistant,
  prompt: string,
  history: Message[],
): Promise<Message[]> {
  write(dim("Thinking..."));
  try {
    const messages = await assistant.run(prompt, history);
    write(CLEAR_LINE);
    console.log(`${green("Agent:")} ${modelText(messages)}\n`);
    return messages;
  } catch (error) {
    write(CLEAR_LINE);
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${red("✖")} ${red(message)}\n`);
    // Keep the prior history so a transient failure doesn't wipe the chat.
    return history;
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
