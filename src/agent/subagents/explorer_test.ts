import { assertEquals, assertStringIncludes } from "@std/assert";
import type { BaseModel, Message, ModelResult } from "@huuma/ai/agent";
import { quiet } from "../testing.ts";
import { explorer } from "./explorer.ts";

/** Minimal scripted model, mirroring @huuma/ai's own StubModel pattern. */
class StubModel implements BaseModel<string> {
  calls: { messages: Message[]; system?: string }[] = [];
  #responses: Message[][];

  constructor(responses: Message[][]) {
    this.#responses = responses;
  }

  generate(args: unknown): Promise<ModelResult<string>> {
    const { messages, system } = args as {
      messages: Message[];
      system?: string;
    };
    this.calls.push({ messages, system });
    const response = this.#responses.shift();
    if (!response) {
      return Promise.reject(new Error("No scripted response left"));
    }
    return Promise.resolve({ modelId: "stub", messages: response });
  }

  stream(): Promise<AsyncGenerator<ModelResult>> {
    return Promise.reject(new Error("Not implemented"));
  }
}

function modelReply(text: string): Message {
  return { role: "model", contents: [{ text }], toolCalls: [] };
}

Deno.test("explorer builds a tool that demands self-contained prompts", () => {
  const tool = explorer({ model: new StubModel([]), modelId: "stub" });
  assertEquals(tool.name, "explorer");
  assertStringIncludes(tool.description, "self-contained");
});

Deno.test("delegation runs the sub-agent and returns its final text", async () => {
  const model = new StubModel([[modelReply("Findings.")]]);
  const tool = explorer({ model, modelId: "stub" });

  const result = await quiet(() => tool.call({ prompt: "inspect src/mod.ts" }));

  assertEquals(result, "Findings.");
  // The delegation prompt arrives as the sub-agent's own fresh conversation.
  assertEquals(model.calls[0].messages, [
    { role: "user", contents: "inspect src/mod.ts" },
  ]);
  assertStringIncludes(model.calls[0].system ?? "", "Explorer");
});
