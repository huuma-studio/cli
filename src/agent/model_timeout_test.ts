import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { MODEL_TIMEOUT_MS } from "./model_timeout.ts";
import { classifyModelError } from "./retry.ts";
import { buildManagedAgent, setup } from "./setup.ts";
import { explorer } from "./subagents/explorer.ts";
import { HangingModel, quiet, track } from "./testing.ts";

// Every agent the CLI builds bounds each model call to MODEL_TIMEOUT_MS: a
// provider that accepts the request but never responds must not hold the
// run forever. Fake time drives the deadline; the hanging model or fetch only
// settles when the abort reaches it.

Deno.test("the model-call deadline is ten minutes", () => {
  assertEquals(MODEL_TIMEOUT_MS, 600_000);
});

Deno.test("a managed agent aborts a stalled model call after MODEL_TIMEOUT_MS", async () => {
  using time = new FakeTime();
  const model = new HangingModel();
  const assistant = buildManagedAgent(
    { model, modelId: "stub" },
    { tools: [], skillsBaseline: [], subagentNames: [], systemPrompt: "x" },
  );

  const run = track(quiet(() => assistant.run("hi", [])));
  await time.tickAsync(MODEL_TIMEOUT_MS - 1);
  assertEquals(run.settled(), false);

  await time.tickAsync(1);
  const error = await assertRejects(() => run.result);
  assertInstanceOf(error, DOMException);
  assertEquals(error.name, "TimeoutError");
  // The deadline reaches the adapter, so the provider request is cancelled
  // rather than abandoned.
  assertEquals(model.signals[0]?.aborted, true);
  // --retries treats a timed-out call as transient (ADR 0010).
  assertEquals(classifyModelError(error), "transient");
});

Deno.test("a managed run's own abort reason wins over the model-call deadline", async () => {
  // The managed runner aborts with ManagedTurnDeadlineError, which must stay
  // permanent — the model-call deadline must not replace that reason.
  using time = new FakeTime();
  const assistant = buildManagedAgent(
    { model: new HangingModel(), modelId: "stub" },
    { tools: [], skillsBaseline: [], subagentNames: [], systemPrompt: "x" },
  );
  const controller = new AbortController();
  const reason = new Error("turn deadline");

  const run = track(
    quiet(() => assistant.run("hi", [], { signal: controller.signal })),
  );
  await time.tickAsync(1_000);
  controller.abort(reason);
  await time.tickAsync(MODEL_TIMEOUT_MS);

  assertEquals(await run.result.catch((error) => error), reason);
});

Deno.test("the explorer sub-agent aborts a stalled model call after MODEL_TIMEOUT_MS", async () => {
  using time = new FakeTime();
  const model = new HangingModel();
  const tool = explorer({ model, modelId: "stub" });

  const call = track(quiet(() => tool.call({ prompt: "inspect src/mod.ts" })));
  await time.tickAsync(MODEL_TIMEOUT_MS - 1);
  assertEquals(call.settled(), false);

  await time.tickAsync(1);
  await call.result.catch(() => {});
  assertEquals(call.settled(), true);
  assertEquals(model.signals[0]?.aborted, true);
});

Deno.test("a local agent aborts a stalled provider request after MODEL_TIMEOUT_MS", async () => {
  // Local setup builds a real adapter, so stall at the transport instead: the
  // ollama adapter's request hangs until its signal aborts.
  const originalFetch = globalThis.fetch;
  const transportSignals: AbortSignal[] = [];
  globalThis.fetch = (input, init) => {
    const signal = init?.signal ??
      (input instanceof Request ? input.signal : undefined);
    if (signal) transportSignals.push(signal);
    return new Promise<Response>((_, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  };
  try {
    using time = new FakeTime();
    const { assistant } = await setup({
      model: { provider: "ollama", modelId: "llama3" },
      host: "http://localhost:11434",
    });

    const run = track(quiet(() => assistant.run("hi", [])));
    await time.tickAsync(MODEL_TIMEOUT_MS - 1);
    assertEquals(run.settled(), false);

    await time.tickAsync(1);
    const error = await assertRejects(() => run.result);
    assertInstanceOf(error, DOMException);
    assertEquals(error.name, "TimeoutError");
    assertEquals(transportSignals.at(0)?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
