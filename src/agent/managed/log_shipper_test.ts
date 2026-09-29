import { assert, assertEquals, assertInstanceOf } from "@std/assert";
import {
  createLogShipper,
  LOG_REQUEST_TIMEOUT_MS,
  LOG_SOURCE,
  type LogShipperOptions,
  MAX_IN_FLIGHT,
  MAX_METADATA_CHARS,
  projectContext,
} from "./log_shipper.ts";

const RUN_ID = "11111111-1111-1111-1111-111111111111";
const TURN_ID = "22222222-2222-2222-2222-222222222222";
const URL_ = new URL("https://logs.example/functions/v1/logs");
const NOW = new Date("2026-09-28T14:54:55.510Z");

type Call = { url: string; init: RequestInit };

/** A fetch recorder whose every call returns the promise `respond` builds.
 * Timeouts are short so no abort timer outlives a test. */
function harness(
  respond: (call: Call) => Promise<Response> = () =>
    Promise.resolve(new Response(null, { status: 202 })),
  overrides: Partial<LogShipperOptions> = {},
) {
  const calls: Call[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  const shipper = createLogShipper({
    url: URL_,
    runId: RUN_ID,
    turnId: TURN_ID,
    sourceVersion: "0.0.52",
    fetch: fetchFn,
    now: () => NOW,
    timeoutMs: 20,
    ...overrides,
  });
  return { shipper, calls };
}

function body(call: Call): Record<string, unknown> {
  return JSON.parse(call.init.body as string);
}

/** Lets pending promise callbacks and short timers run. */
function settle(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A fetch result that settles only when the request's signal aborts. */
function untilAborted(call: Call): Promise<Response> {
  return new Promise((_, reject) => {
    call.init.signal?.addEventListener(
      "abort",
      () => reject(call.init.signal?.reason),
    );
  });
}

Deno.test("createLogShipper without a URL is a no-op", async () => {
  let calls = 0;
  const shipper = createLogShipper({
    url: undefined,
    sourceVersion: "0.0.52",
    fetch: (() => {
      calls += 1;
      return Promise.resolve(new Response(null));
    }) as typeof fetch,
  });
  shipper.send({ level: "error", message: "boom" });
  await settle();
  assertEquals(calls, 0);
});

Deno.test("send returns before fetch resolves and posts an enriched JSON entry", async () => {
  let resolveFetch!: (response: Response) => void;
  const { shipper, calls } = harness(() =>
    new Promise((resolve) => resolveFetch = resolve)
  );
  const result = shipper.send({
    level: "error",
    message: "provider failed",
    scope: "managed",
    stage: "agent.run",
    context: { callback_kind: "conflict", exit_code: 1 },
  });
  assertEquals(result, undefined);
  assertEquals(calls.length, 1);
  const [call] = calls;
  assertEquals(call.url, URL_.href);
  assertEquals(call.init.method, "POST");
  assertEquals(
    new Headers(call.init.headers).get("Content-Type"),
    "application/json",
  );
  assertEquals(call.init.redirect, "error");
  assertInstanceOf(call.init.signal, AbortSignal);
  assertEquals(body(call), {
    level: "error",
    message: "provider failed",
    source: LOG_SOURCE,
    source_version: "0.0.52",
    scope: "managed",
    stage: "agent.run",
    run_id: RUN_ID,
    turn_id: TURN_ID,
    occurred_at: "2026-09-28T14:54:55.510Z",
    context: { callback_kind: "conflict", exit_code: 1 },
  });
  resolveFetch(new Response(null, { status: 202 }));
  await settle();
});

Deno.test("the production request timeout is two seconds", () => {
  assertEquals(LOG_REQUEST_TIMEOUT_MS, 2_000);
  assertEquals(MAX_IN_FLIGHT, 4);
});

Deno.test("invalid correlation IDs are omitted independently", async () => {
  const { shipper, calls } = harness(undefined, {
    runId: "not-a-uuid",
    turnId: TURN_ID,
  });
  shipper.send({ level: "warn", message: "m" });
  const sent = body(calls[0]);
  assertEquals("run_id" in sent, false);
  assertEquals(sent.turn_id, TURN_ID);
  await settle();
});

Deno.test("messages are bounded to 1,024 UTF-8 bytes and metadata to 128 code points", async () => {
  const { shipper, calls } = harness();
  shipper.send({
    level: "error",
    message: "€".repeat(500), // 1,500 bytes
    stage: "😀".repeat(200),
    scope: "s",
  });
  const sent = body(calls[0]);
  const message = sent.message as string;
  assert(new TextEncoder().encode(message).byteLength <= 1024);
  assertEquals(message, "€".repeat(341));
  assertEquals(Array.from(sent.stage as string).length, MAX_METADATA_CHARS);
  assertEquals(sent.stage, "😀".repeat(MAX_METADATA_CHARS));
  await settle();
});

Deno.test("context is projected onto the typed allowlist", () => {
  assertEquals(projectContext(undefined), undefined);
  assertEquals(projectContext({}), undefined);
  assertEquals(projectContext({ attempt: 1 }), { attempt: 1 });
  assertEquals(projectContext({ attempt: 11 }), { attempt: 11 });
  for (const attempt of [0, 12, 1.5, NaN]) {
    assertEquals(projectContext({ attempt }), undefined);
  }
  assertEquals(
    projectContext({
      callback_kind: "rate-limited" as never,
      exit_code: 2 as never,
      stack: "at x",
      error: "raw",
    } as never),
    undefined,
  );
  assertEquals(
    projectContext({
      attempt: 3,
      callback_kind: "budget-exhausted",
      exit_code: 0,
      extra: { nested: true },
    } as never),
    { attempt: 3, callback_kind: "budget-exhausted", exit_code: 0 },
  );
});

Deno.test("a synchronously throwing fetch is swallowed and frees its slot", async () => {
  let count = 0;
  const { shipper } = harness(() => {
    count += 1;
    throw new Error("sync fetch failure");
  });
  for (let i = 0; i < MAX_IN_FLIGHT + 2; i++) {
    shipper.send({ level: "error", message: `m${i}` });
  }
  assertEquals(count, MAX_IN_FLIGHT + 2);
  await settle(30);
});

Deno.test("a rejecting fetch is swallowed without an unhandled rejection", async () => {
  const { shipper, calls } = harness(() =>
    Promise.reject(new TypeError("network down"))
  );
  shipper.send({ level: "error", message: "m" });
  await settle(30);
  // The slot was released: further sends still reach fetch.
  for (let i = 0; i < MAX_IN_FLIGHT; i++) {
    shipper.send({ level: "error", message: `m${i}` });
  }
  assertEquals(calls.length, MAX_IN_FLIGHT + 1);
  await settle(30);
});

Deno.test("serialization and clock failures never escape send", async () => {
  const { shipper, calls } = harness(undefined, {
    now: () => {
      throw new Error("clock broken");
    },
  });
  shipper.send({
    level: "error",
    message: {
      toString() {
        throw new Error("hostile");
      },
    } as unknown as string,
  });
  assertEquals(calls.length, 0);
  shipper.send({ level: "error", message: "ok" });
  assertEquals(calls.length, 1);
  assertEquals("occurred_at" in body(calls[0]), false);
  await settle(30);
});

Deno.test("occurred_at is omitted when the clock is outside years 0001–9999", async () => {
  for (
    const date of [
      new Date(Date.UTC(10000, 0, 1)),
      new Date("0000-06-01T00:00:00.000Z"),
      new Date(NaN),
    ]
  ) {
    const { shipper, calls } = harness(undefined, { now: () => date });
    shipper.send({ level: "error", message: "m" });
    assertEquals("occurred_at" in body(calls[0]), false, String(date));
  }
  const { shipper, calls } = harness(undefined, {
    now: () => new Date("0001-01-01T00:00:00.000Z"),
  });
  shipper.send({ level: "error", message: "m" });
  assertEquals(body(calls[0]).occurred_at, "0001-01-01T00:00:00.000Z");
  await settle(30);
});

Deno.test("response bodies are cancelled as soon as headers arrive", async () => {
  let cancelled = false;
  const { shipper } = harness(() =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 500 },
      ),
    )
  );
  shipper.send({ level: "error", message: "m" });
  await settle(30);
  assert(cancelled);
});

Deno.test("response cleanup failures are swallowed", async () => {
  const { shipper, calls } = harness(() =>
    Promise.resolve({
      status: 202,
      body: {
        cancel() {
          throw new Error("cancel failed");
        },
      },
    } as unknown as Response)
  );
  shipper.send({ level: "error", message: "m" });
  await settle(30);
  // The slot was released despite the cleanup failure.
  for (let i = 0; i < MAX_IN_FLIGHT; i++) {
    shipper.send({ level: "error", message: `m${i}` });
  }
  assertEquals(calls.length, MAX_IN_FLIGHT + 1);
  await settle(30);
});

Deno.test("at most four requests are in flight; excess sends are dropped", async () => {
  const resolvers: ((response: Response) => void)[] = [];
  const { shipper, calls } = harness(
    () => new Promise((resolve) => resolvers.push(resolve)),
    { timeoutMs: 1_000 },
  );
  for (let i = 0; i < MAX_IN_FLIGHT + 3; i++) {
    shipper.send({ level: "error", message: `m${i}` });
  }
  assertEquals(calls.length, MAX_IN_FLIGHT);
  // Completing one request frees exactly one slot.
  resolvers[0](new Response(null, { status: 202 }));
  await settle();
  shipper.send({ level: "error", message: "next" });
  shipper.send({ level: "error", message: "dropped" });
  assertEquals(calls.length, MAX_IN_FLIGHT + 1);
  assertEquals(body(calls[MAX_IN_FLIGHT]).message, "next");
  for (const resolve of resolvers.slice(1)) {
    resolve(new Response(null, { status: 202 }));
  }
  await settle(1_050);
});

Deno.test("timed-out requests are aborted and their slots become reusable", async () => {
  const { shipper, calls } = harness(untilAborted);
  for (let i = 0; i < MAX_IN_FLIGHT + 1; i++) {
    shipper.send({ level: "error", message: `m${i}` });
  }
  assertEquals(calls.length, MAX_IN_FLIGHT);
  await settle(60);
  assert(calls.every((call) => call.init.signal?.aborted));
  shipper.send({ level: "error", message: "after timeout" });
  assertEquals(calls.length, MAX_IN_FLIGHT + 1);
  await settle(60);
});

Deno.test("a fetch that ignores its signal still releases its slot on abort", async () => {
  const { shipper, calls } = harness(() => new Promise(() => {}));
  for (let i = 0; i < MAX_IN_FLIGHT; i++) {
    shipper.send({ level: "error", message: `m${i}` });
  }
  shipper.send({ level: "error", message: "dropped" });
  assertEquals(calls.length, MAX_IN_FLIGHT);
  await settle(60);
  shipper.send({ level: "error", message: "after abort" });
  assertEquals(calls.length, MAX_IN_FLIGHT + 1);
  await settle(60);
});
