import { assertEquals, assertRejects } from "@std/assert";
import {
  type CallbackDeps,
  type CallbackError,
  CallbackError as CallbackErrorClass,
  type CallbackErrorKind,
  CallbackReporter,
  type ResponseLike,
  sanitizeError,
  truncateUtf8Bytes,
} from "./callback.ts";

/** A recorded fetch call: the URL and the init the reporter passed. */
interface RecordedFetch {
  url: string;
  init: {
    method: string;
    headers: Record<string, string>;
    body: Uint8Array;
    timeoutMs: number;
  };
}

interface HarnessOptions {
  callbackUrl?: string;
  callbackSecret?: string;
  runId?: string;
  turnId?: string;
  /** Turn deadline as ms-since-test-clock-origin. The test clock starts at 0
   * and advances only when `sleep` is called. */
  turnDeadlineMs?: number;
  random?: () => number;
  /** Each entry is either a response to return or an Error to throw. */
  responses?: (ResponseLike | Error)[];
}

/** Builds a reporter backed by deterministic deps. The clock starts at 0 and
 * advances by the sleep duration on each `sleep` call. `fetch` records every
 * call and returns (or throws) the next queued response. */
function makeHarness(opts: HarnessOptions = {}) {
  const callbackUrl = opts.callbackUrl ?? "https://callback.example/cb";
  const callbackSecret = opts.callbackSecret ?? "turn-secret";
  const runId = opts.runId ?? "run-1";
  const turnId = opts.turnId ?? "turn-1";
  const turnDeadlineMs = opts.turnDeadlineMs ?? 60_000;
  let clockMs = 0;
  const sleepCalls: number[] = [];
  const fetchCalls: RecordedFetch[] = [];
  const queue = [...(opts.responses ?? [])];
  const randomFn = opts.random ?? (() => 0);
  const deps: CallbackDeps = {
    now: () => new Date(clockMs),
    sleep: (ms: number) => {
      sleepCalls.push(ms);
      clockMs += ms;
      return Promise.resolve();
    },
    random: randomFn,
    fetch: (url: string, init) => {
      fetchCalls.push({
        url,
        init: {
          method: init.method,
          headers: { ...init.headers },
          body: init.body,
          timeoutMs: init.timeoutMs,
        },
      });
      const next = queue.shift();
      if (next === undefined) {
        throw new Error("test ran out of queued responses");
      }
      if (next instanceof Error) throw next;
      return Promise.resolve(next);
    },
  };
  const reporter = new CallbackReporter({
    callbackUrl,
    callbackSecret,
    runId,
    turnId,
    turnDeadline: new Date(turnDeadlineMs),
    deps,
  });
  return {
    reporter,
    deps,
    sleepCalls,
    fetchCalls,
    clock: () => clockMs,
  };
}

function decodeBody(body: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(body));
}

/** Asserts `fn` rejects with a `CallbackError` of the given `kind`. */
async function expectKind(
  fn: () => Promise<unknown>,
  kind: CallbackErrorKind,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof CallbackErrorClass)) throw e;
    assertEquals(e.kind, kind);
    return;
  }
  throw new Error(`expected ${fn.name} to reject with CallbackError(${kind})`);
}

function response(
  status: number,
  headers?: Record<string, string>,
): ResponseLike {
  if (headers) return { status, headers: new Headers(headers) };
  return { status };
}

// ---------------------------------------------------------------------------
// 1. Event methods: exact body bytes and headers.
// ---------------------------------------------------------------------------

Deno.test("turnRunning posts the exact envelope with correct headers", async () => {
  const h = makeHarness({ responses: [response(204)] });
  await h.reporter.turnRunning();
  assertEquals(h.fetchCalls.length, 1);
  const call = h.fetchCalls[0]!;
  assertEquals(call.url, "https://callback.example/cb");
  assertEquals(call.init.method, "POST");
  assertEquals(call.init.headers["Authorization"], "Bearer turn-secret");
  assertEquals(call.init.headers["Content-Type"], "application/json");
  assertEquals(call.init.headers["Idempotency-Key"], "turn-1:turn.running");
  assertEquals(decodeBody(call.init.body), {
    run_id: "run-1",
    turn_id: "turn-1",
    event: "turn.running",
  });
});

Deno.test("messageAppended posts verbatim message with sequence-derived key", async () => {
  const h = makeHarness({ responses: [response(204), response(204)] });
  const message = { role: "model", contents: [{ text: "Working on it." }] };
  await h.reporter.messageAppended(1, message);
  const call = h.fetchCalls[0]!;
  assertEquals(
    call.init.headers["Idempotency-Key"],
    "turn-1:message.appended:1",
  );
  assertEquals(call.init.headers["Content-Type"], "application/json");
  assertEquals(decodeBody(call.init.body), {
    run_id: "run-1",
    turn_id: "turn-1",
    event: "message.appended",
    turn_sequence: 1,
    message,
  });
  // sequence 2 gets a distinct key
  await h.reporter.messageAppended(2, message);
  assertEquals(
    h.fetchCalls[1]!.init.headers["Idempotency-Key"],
    "turn-1:message.appended:2",
  );
});

Deno.test("messageAppended rejects sequence 0 (reserved) and non-integers", async () => {
  const h = makeHarness({ responses: [response(204)] });
  await assertRejects(
    () => h.reporter.messageAppended(0, { role: "model" }),
    Error,
  );
  await assertRejects(
    () => h.reporter.messageAppended(1.5, { role: "model" }),
    Error,
  );
  assertEquals(h.fetchCalls.length, 0);
});

Deno.test("turnFinished posts outcome with shared terminal idempotency key", async () => {
  const h = makeHarness({ responses: [response(204), response(204)] });
  await h.reporter.turnFinished("completion");
  const call = h.fetchCalls[0]!;
  assertEquals(call.init.headers["Idempotency-Key"], "turn-1:terminal");
  assertEquals(decodeBody(call.init.body), {
    run_id: "run-1",
    turn_id: "turn-1",
    event: "turn.finished",
    outcome: "completion",
  });
  // question outcome too
  await h.reporter.turnFinished("question");
  assertEquals(decodeBody(h.fetchCalls[1]!.init.body), {
    run_id: "run-1",
    turn_id: "turn-1",
    event: "turn.finished",
    outcome: "question",
  });
});

Deno.test("turnFailed posts sanitized error with shared terminal idempotency key", async () => {
  const h = makeHarness({ responses: [response(204)] });
  await h.reporter.turnFailed("provider down");
  const call = h.fetchCalls[0]!;
  assertEquals(call.init.headers["Idempotency-Key"], "turn-1:terminal");
  assertEquals(decodeBody(call.init.body), {
    run_id: "run-1",
    turn_id: "turn-1",
    event: "turn.failed",
    error: "provider down",
  });
});

Deno.test("turnFinished and turnFailed share the terminal idempotency key", async () => {
  const h = makeHarness({ responses: [response(204), response(204)] });
  await h.reporter.turnFinished("question");
  await h.reporter.turnFailed("oops");
  assertEquals(
    h.fetchCalls[0]!.init.headers["Idempotency-Key"],
    h.fetchCalls[1]!.init.headers["Idempotency-Key"],
  );
  assertEquals(
    h.fetchCalls[1]!.init.headers["Idempotency-Key"],
    "turn-1:terminal",
  );
});

// ---------------------------------------------------------------------------
// 3. Body bytes are reused across retries (same reference + same bytes).
// ---------------------------------------------------------------------------

Deno.test("body bytes and idempotency key are reused verbatim across retries", async () => {
  const h = makeHarness({
    turnDeadlineMs: 120_000,
    responses: [
      response(500),
      response(500),
      response(500),
      response(204),
    ],
  });
  await h.reporter.turnRunning();
  assertEquals(h.fetchCalls.length, 4);
  const firstBody = h.fetchCalls[0]!.init.body;
  for (const call of h.fetchCalls) {
    // Same Uint8Array reference, not a fresh copy.
    if (call.init.body !== firstBody) {
      throw new Error("body bytes were not reused by reference");
    }
    // Same idempotency key.
    assertEquals(
      call.init.headers["Idempotency-Key"],
      h.fetchCalls[0]!.init.headers["Idempotency-Key"],
    );
  }
});

// ---------------------------------------------------------------------------
// 4. Durable acknowledgements: 200, 201, 204.
// ---------------------------------------------------------------------------

for (const status of [200, 201, 204]) {
  Deno.test(`status ${status} is a durable acknowledgement (no retry)`, async () => {
    const h = makeHarness({ responses: [response(status)] });
    await h.reporter.turnRunning();
    assertEquals(h.fetchCalls.length, 1);
    assertEquals(h.sleepCalls.length, 0);
  });
}

// ---------------------------------------------------------------------------
// 5. 202 and other 2xx are fatal-failable.
// ---------------------------------------------------------------------------

for (const status of [202, 206]) {
  Deno.test(`status ${status} is fatal-failable`, async () => {
    const h = makeHarness({ responses: [response(status)] });
    await expectKind(() => h.reporter.turnRunning(), "fatal-failable");
    assertEquals(h.fetchCalls.length, 1);
    assertEquals(h.sleepCalls.length, 0);
  });
}

// ---------------------------------------------------------------------------
// 6. 400, 413, 404, 422 are fatal-failable.
// ---------------------------------------------------------------------------

for (const status of [400, 413, 404, 422]) {
  Deno.test(`status ${status} is fatal-failable`, async () => {
    const h = makeHarness({ responses: [response(status)] });
    await expectKind(() => h.reporter.turnRunning(), "fatal-failable");
    assertEquals(h.fetchCalls.length, 1);
    assertEquals(h.sleepCalls.length, 0);
  });
}

// ---------------------------------------------------------------------------
// 7. 401 and 403 are auth-stop (no retries).
// ---------------------------------------------------------------------------

for (const status of [401, 403]) {
  Deno.test(`status ${status} is auth-stop with no retries`, async () => {
    const h = makeHarness({ responses: [response(status)] });
    await expectKind(() => h.reporter.turnRunning(), "auth-stop");
    assertEquals(h.fetchCalls.length, 1);
    assertEquals(h.sleepCalls.length, 0);
  });
}

// ---------------------------------------------------------------------------
// 8. 409 is conflict.
// ---------------------------------------------------------------------------

Deno.test("status 409 is conflict", async () => {
  const h = makeHarness({ responses: [response(409)] });
  await expectKind(() => h.reporter.turnRunning(), "conflict");
  assertEquals(h.fetchCalls.length, 1);
  assertEquals(h.sleepCalls.length, 0);
});

// ---------------------------------------------------------------------------
// 9. 408, 429, 500, 503, and network failure are transient and retried.
// ---------------------------------------------------------------------------

for (const status of [408, 429, 500, 503]) {
  Deno.test(`status ${status} is transient and retried, then succeeds on 204`, async () => {
    const h = makeHarness({
      turnDeadlineMs: 60_000,
      responses: [response(status), response(204)],
    });
    await h.reporter.turnRunning();
    assertEquals(h.fetchCalls.length, 2);
    assertEquals(h.sleepCalls.length, 1);
  });
}

Deno.test("network failure (fetch throws) is transient and retried", async () => {
  const h = makeHarness({
    turnDeadlineMs: 60_000,
    responses: [new Error("network down"), response(204)],
  });
  await h.reporter.turnRunning();
  assertEquals(h.fetchCalls.length, 2);
  assertEquals(h.sleepCalls.length, 1);
});

// ---------------------------------------------------------------------------
// 10. Retry-After honored within cutoff; ignored when it extends beyond.
// ---------------------------------------------------------------------------

Deno.test("Retry-After is honored when within the cutoff", async () => {
  const h = makeHarness({
    turnDeadlineMs: 30_000, // non-terminal cutoff = 15_000
    responses: [response(500, { "Retry-After": "1" }), response(204)],
  });
  await h.reporter.turnRunning();
  // now=0; Retry-After=1000ms; 0+1000 ≤ 15000 → sleep 1000 (not the 125ms backoff)
  assertEquals(h.sleepCalls, [1000]);
});

Deno.test("Retry-After is ignored when it extends beyond the cutoff", async () => {
  const h = makeHarness({
    turnDeadlineMs: 30_000, // non-terminal cutoff = 15_000
    responses: [response(500, { "Retry-After": "20" }), response(204)],
  });
  await h.reporter.turnRunning();
  // now=0; Retry-After=20000ms; 0+20000 > 15000 → ignore; backoff = 250*0.5 = 125 (random=0)
  assertEquals(h.sleepCalls, [125]);
});

Deno.test("non-integer Retry-After is ignored", async () => {
  const h = makeHarness({
    turnDeadlineMs: 30_000,
    responses: [response(500, { "Retry-After": "tomorrow" }), response(204)],
  });
  await h.reporter.turnRunning();
  // unparseable Retry-After falls back to backoff
  assertEquals(h.sleepCalls, [125]);
});

// ---------------------------------------------------------------------------
// 11. Non-terminal retries stop at turnDeadline - 15_000; terminal until deadline.
// ---------------------------------------------------------------------------

Deno.test("non-terminal retries stop at turnDeadline - 15_000 ms", async () => {
  // deadline = 16_000 → non-terminal cutoff = 1_000 ms.
  const h = makeHarness({
    turnDeadlineMs: 16_000,
    responses: Array.from({ length: 20 }, () => response(500)),
  });
  await expectKind(() => h.reporter.turnRunning(), "budget-exhausted");
  // Trace with random=0 (sleepMs = base * 0.5):
  //   a0: sleep 125 → clock 125
  //   a1: sleep 250 → clock 375
  //   a2: sleep 500 → clock 875
  //   a3: backoff 1000 > remaining(125) → throw
  assertEquals(h.sleepCalls, [125, 250, 500]);
  assertEquals(h.fetchCalls.length, 4);
});

Deno.test("terminal retries continue until turnDeadline", async () => {
  // deadline = 2_000 → terminal cutoff = 2_000 ms.
  const h = makeHarness({
    turnDeadlineMs: 2_000,
    responses: Array.from({ length: 20 }, () => response(500)),
  });
  await expectKind(() => h.reporter.turnFailed("oops"), "budget-exhausted");
  // Trace with random=0:
  //   a0: 125 → 125; a1: 250 → 375; a2: 500 → 875; a3: 1000 → 1875;
  //   a4: backoff 2000 > remaining(125) → throw
  assertEquals(h.sleepCalls, [125, 250, 500, 1000]);
  assertEquals(h.fetchCalls.length, 5);
});

Deno.test("terminal cutoff is 15s later than non-terminal cutoff for the same deadline", async () => {
  const deadline = 20_000;
  const h1 = makeHarness({
    turnDeadlineMs: deadline,
    responses: Array.from({ length: 40 }, () => response(500)),
  });
  await expectKind(() => h1.reporter.turnRunning(), "budget-exhausted");
  const h2 = makeHarness({
    turnDeadlineMs: deadline,
    responses: Array.from({ length: 40 }, () => response(500)),
  });
  await expectKind(() => h2.reporter.turnFailed("oops"), "budget-exhausted");
  // Terminal event has 15s more retry budget, so more attempts fit.
  assertEquals(h2.fetchCalls.length > h1.fetchCalls.length, true);
});

// ---------------------------------------------------------------------------
// 12. Exponential backoff with jitter starts at 250ms, caps at 5s.
// ---------------------------------------------------------------------------

Deno.test("exponential backoff with jitter starts at 250ms and caps at 5s", async () => {
  // random() = 1 → jitter factor = 1.0 → sleepMs = base exactly.
  const h = makeHarness({
    turnDeadlineMs: 120_000,
    random: () => 1,
    responses: [
      response(500), // a0: backoff 250
      response(500), // a1: backoff 500
      response(500), // a2: backoff 1000
      response(500), // a3: backoff 2000
      response(500), // a4: backoff 4000
      response(500), // a5: base capped at 5000
      response(500), // a6: base capped at 5000
      response(204), // a7: success
    ],
  });
  await h.reporter.turnRunning();
  assertEquals(h.sleepCalls, [250, 500, 1000, 2000, 4000, 5000, 5000]);
  assertEquals(h.fetchCalls.length, 8);
});

Deno.test("exponential backoff lower bound (random=0) is half the base", async () => {
  // random() = 0 → jitter factor = 0.5 → sleepMs = base * 0.5.
  const h = makeHarness({
    turnDeadlineMs: 120_000,
    random: () => 0,
    responses: [
      response(500),
      response(500),
      response(500),
      response(500),
      response(500),
      response(500),
      response(204),
    ],
  });
  await h.reporter.turnRunning();
  // base: 250, 500, 1000, 2000, 4000, 5000(cap) → sleepMs: 125, 250, 500, 1000, 2000, 2500
  assertEquals(h.sleepCalls, [125, 250, 500, 1000, 2000, 2500]);
});

// ---------------------------------------------------------------------------
// 13. Per-attempt timeout at most 10s, reduced when remaining < 10s.
// ---------------------------------------------------------------------------

Deno.test("per-attempt timeout is capped at 10s when remaining time is large", async () => {
  const h = makeHarness({
    turnDeadlineMs: 60_000, // non-terminal cutoff = 45_000
    responses: [response(204)],
  });
  await h.reporter.turnRunning();
  assertEquals(h.fetchCalls[0]!.init.timeoutMs, 10_000);
});

Deno.test("per-attempt timeout is reduced to remaining time when less than 10s", async () => {
  // non-terminal cutoff = 20_000 - 15_000 = 5_000ms remaining.
  const h = makeHarness({
    turnDeadlineMs: 20_000,
    responses: [response(204)],
  });
  await h.reporter.turnRunning();
  assertEquals(h.fetchCalls[0]!.init.timeoutMs, 5_000);
});

Deno.test("per-attempt timeout uses the terminal cutoff for terminal events", async () => {
  // terminal cutoff = deadline itself = 5_000ms remaining.
  const h = makeHarness({
    turnDeadlineMs: 5_000,
    responses: [response(204)],
  });
  await h.reporter.turnFailed("oops");
  assertEquals(h.fetchCalls[0]!.init.timeoutMs, 5_000);
});

// ---------------------------------------------------------------------------
// 14. Budget exhaustion throws CallbackError { kind: "budget-exhausted" }.
// ---------------------------------------------------------------------------

Deno.test("exhausting the retry budget throws budget-exhausted", async () => {
  const h = makeHarness({
    turnDeadlineMs: 16_000,
    responses: Array.from({ length: 20 }, () => response(500)),
  });
  const err = await assertRejects(
    () => h.reporter.turnRunning(),
    CallbackErrorClass,
  ) as CallbackError;
  assertEquals(err.kind, "budget-exhausted");
});

Deno.test("first attempt with no remaining time throws budget-exhausted", async () => {
  // non-terminal cutoff = deadline - 15_000 < 0 → no budget at all.
  const h = makeHarness({
    turnDeadlineMs: 5_000,
    responses: [response(204)],
  });
  await expectKind(() => h.reporter.turnRunning(), "budget-exhausted");
  assertEquals(h.fetchCalls.length, 0);
});

// ---------------------------------------------------------------------------
// 15. sanitizeError: redaction + truncation.
// ---------------------------------------------------------------------------

Deno.test("sanitizeError strips Authorization header lines entirely", () => {
  const out = sanitizeError(
    "Authorization: Bearer sk-abcdef0123456789\nfailed afterwards",
  );
  assertEquals(out.includes("sk-abcdef0123456789"), false);
  assertEquals(out.includes("Bearer"), false);
  assertEquals(out.includes("failed afterwards"), true);
});

Deno.test("sanitizeError redacts Bearer tokens in prose", () => {
  const out = sanitizeError(
    "request failed with Bearer abc12345678901234567890 token rejected",
  );
  assertEquals(out.includes("abc12345678901234567890"), false);
  assertEquals(out.includes("Bearer [redacted]"), true);
});

Deno.test("sanitizeError redacts sk- prefixed api keys outside headers", () => {
  const out = sanitizeError("api key sk-abcd1234xyz rejected");
  assertEquals(out.includes("sk-abcd1234xyz"), false);
  assertEquals(out.includes("sk-[redacted]"), true);
});

Deno.test("sanitizeError redacts api_key= query values", () => {
  const out = sanitizeError("api_key=ABCDEF0123456789 invalid");
  assertEquals(out.includes("ABCDEF0123456789"), false);
  assertEquals(out.includes("api_key=[redacted]"), true);
});

Deno.test("sanitizeError redacts long alphanumeric runs (hex/base64url/JWT-like)", () => {
  const out = sanitizeError("hash=abcdef0123456789abcdef0123456789 commit");
  assertEquals(out.includes("abcdef0123456789abcdef0123456789"), false);
  assertEquals(out.includes("[redacted]"), true);
});

Deno.test("sanitizeError does not redact short snake_case identifiers or file paths", () => {
  // Underscores break the alphanumeric run; ordinary paths/identifiers survive.
  const out = sanitizeError(
    "at callback_reporter (./src/agent/managed/callback.ts)",
  );
  assertEquals(out.includes("callback_reporter"), true);
  assertEquals(out.includes("./src/agent/managed/callback.ts"), true);
});

Deno.test("sanitizeError truncates to <=1024 UTF-8 bytes", () => {
  const out = sanitizeError(new Error("x".repeat(2000)));
  const bytes = new TextEncoder().encode(out);
  assertEquals(bytes.byteLength <= 1024, true);
  // round-trips through UTF-8 (no invalid sequences)
  assertEquals(new TextDecoder().decode(bytes), out);
});

Deno.test("sanitizeError truncates multibyte input on a code point boundary", () => {
  const s = "α".repeat(600) + " tail"; // α is 2 UTF-8 bytes
  const out = sanitizeError(s);
  const bytes = new TextEncoder().encode(out);
  assertEquals(bytes.byteLength <= 1024, true);
  assertEquals(new TextDecoder().decode(bytes), out);
  // The last code point is still a whole α (not a replacement char).
  assertEquals(out.endsWith("α") || out.endsWith(" tail"), true);
});

Deno.test("sanitizeError coerces non-Error throws to string", () => {
  assertEquals(sanitizeError("plain string"), "plain string");
  assertEquals(sanitizeError(42), "42");
  assertEquals(sanitizeError({ toString: () => "obj" }), "obj");
});

Deno.test("sanitizeError truncates after redaction, not before", () => {
  // A long redacted run should still fit within the byte budget.
  const out = sanitizeError("Bearer " + "a".repeat(2000));
  const bytes = new TextEncoder().encode(out);
  assertEquals(bytes.byteLength <= 1024, true);
  assertEquals(out.startsWith("Bearer [redacted]"), true);
});

// ---------------------------------------------------------------------------
// truncateUtf8Bytes direct tests.
// ---------------------------------------------------------------------------

Deno.test("truncateUtf8Bytes keeps short strings unchanged", () => {
  assertEquals(truncateUtf8Bytes("hello", 100), "hello");
});

Deno.test("truncateUtf8Bytes returns empty for maxBytes <= 0", () => {
  assertEquals(truncateUtf8Bytes("hello", 0), "");
  assertEquals(truncateUtf8Bytes("hello", -5), "");
});

Deno.test("truncateUtf8Bytes truncates ASCII at a byte boundary", () => {
  assertEquals(truncateUtf8Bytes("abcdefghij", 5), "abcde");
});

Deno.test("truncateUtf8Bytes truncates multibyte at a code point boundary", () => {
  const s = "α".repeat(600); // 1200 bytes
  const out = truncateUtf8Bytes(s, 1023); // odd cut would land mid-α
  const bytes = new TextEncoder().encode(out);
  assertEquals(bytes.byteLength <= 1023, true);
  // 1023 is odd; backing up past the continuation byte lands on 1022 (511 α's).
  assertEquals(bytes.byteLength, 1022);
  assertEquals(new TextDecoder().decode(bytes), out);
  assertEquals(out.endsWith("α"), true);
});

Deno.test("truncateUtf8Bytes handles 4-byte code points (emoji)", () => {
  // "😀" is U+1F600, 4 UTF-8 bytes. 1023 bytes from a 1020-byte prefix lands
  // inside a 4-byte sequence; back up to the leading byte.
  const s = "😀".repeat(300); // 1200 bytes
  const out = truncateUtf8Bytes(s, 1023);
  const bytes = new TextEncoder().encode(out);
  assertEquals(bytes.byteLength <= 1023, true);
  assertEquals(new TextDecoder().decode(bytes), out);
  assertEquals(out.endsWith("😀"), true);
});
