import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type {
  BaseModel,
  JSONSchema,
  Message,
  ModelResult,
} from "@huuma/ai/agent";
import { MAX_MODEL_CALLS } from "../max_model_calls.ts";
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

/** A model that answers every call with a `read_file` tool call, driving the
 * sub-agent loop until the cap rejects. Used to prove the CLI's
 * `maxModelCalls` contract for the preset's own inner agent. */
class LoopingReadFileModel implements BaseModel<string> {
  calls = 0;

  generate(_args: unknown): Promise<ModelResult<string>> {
    this.calls += 1;
    const toolCall = {
      id: "call-loop",
      name: "read_file",
      // A missing path makes every read fail, and a failed tool call is a
      // non-terminal error result, so the sub-agent keeps going until the cap.
      props: {
        path: "/definitely-missing-cap-test-file",
      } as unknown as JSONSchema,
    };
    return Promise.resolve({
      modelId: "stub",
      messages: [
        { role: "model", contents: [{ toolCall }], toolCalls: [toolCall] },
      ],
    });
  }

  stream(): Promise<AsyncGenerator<ModelResult>> {
    return Promise.reject(new Error("Not implemented"));
  }
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

Deno.test("explorer caps the sub-agent run at MAX_MODEL_CALLS model calls", async () => {
  // The preset builds its own inner agent, so the cap lives here too: a
  // sub-agent that keeps requesting tools must reject with the CLI's
  // MAX_MODEL_CALLS cap, not the library's 100-call default.
  const model = new LoopingReadFileModel();
  const tool = explorer({ model, modelId: "stub" });
  await assertRejects(
    () => quiet(() => tool.call({ prompt: "inspect src/mod.ts" })),
    Error,
    `maxModelCalls (${MAX_MODEL_CALLS})`,
  );
  assertEquals(model.calls, MAX_MODEL_CALLS);
});
