import { assertEquals } from "@std/assert";
import { CallbackError } from "./managed/callback.ts";
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  classifyModelError,
  productionRetryDeps,
  ProtocolError,
  runWithRetries,
  type RetryDeps,
} from "./retry.ts";

/** Fake timing sources with a clock that advances by each sleep duration and
 * recorders for the sleeps, mirroring the callback-test harness. */
function fakeDeps(
  opts: { random?: () => number; initialMs?: number } = {},
): { deps: RetryDeps; sleeps: number[]; clock: () => number } {
  let clockMs = opts.initialMs ?? 0;
  const sleeps: number[] = [];
  const deps: RetryDeps = {
    now: () => new Date(clockMs),
    sleep: (ms) => {
      sleeps.push(ms);
      clockMs += ms;
      return Promise.resolve();
    },
    random: opts.random ?? (() => 0),
  };
  return { deps, sleeps, clock: () => clockMs };
}

/** A transient-looking provider error. */
function transientError(): Error {
  return new Error("429 Too Many Requests");
}

// ---------------------------------------------------------------------------
// classifyModelError — the classification table (ADR 0010)
// ---------------------------------------------------------------------------

const TRANSIENT_MESSAGES = [
  "429 Too Many Requests",
  "Request failed with status code 429",
  "rate limit exceeded for model",
  "Rate limit reached, please retry",
  "408 Request Timeout",
  "500 Internal Server Error",
  "502 Bad Gateway",
  "503 Service Unavailable",
  "Request failed with status code 504",
  "the provider is overloaded, try again",
  "Request timed out after 30000ms",
  "connection reset by peer",
  "fetch failed",
  "ECONNRESET",
  "network error while calling the provider",
  // Unknown messages lean transient — attempts are bounded, so a wasted
  // retry is cheaper than an avoidable failure (ADR 0010).
  "provider exploded mysteriously",
  "",
];

const PERMANENT_MESSAGES = [
  "401 Unauthorized",
  "Request failed with status code 403",
  "Unauthorized",
  "Forbidden",
  "invalid api key provided",
  "Incorrect API key provided",
  "invalid_request_error: the request body is malformed",
  "Invalid request: unknown parameter",
  "missing API key",
];

Deno.test("classifyModelError classifies transient message patterns", () => {
  for (const message of TRANSIENT_MESSAGES) {
    assertEquals(
      classifyModelError(new Error(message)),
      "transient",
      `expected transient: ${JSON.stringify(message)}`,
    );
  }
});

Deno.test("classifyModelError classifies permanent message patterns", () => {
  for (const message of PERMANENT_MESSAGES) {
    assertEquals(
      classifyModelError(new Error(message)),
      "permanent",
      `expected permanent: ${JSON.stringify(message)}`,
    );
  }
});

Deno.test("classifyModelError classifies every CallbackError kind permanent", () => {
  // Delivery failures are not model failures — retrying run() would re-drive
  // the callback path. Even the budget-exhausted kind stays permanent here.
  for (const kind of [
    "auth-stop",
    "conflict",
    "fatal-failable",
    "budget-exhausted",
  ] as const) {
    assertEquals(
      classifyModelError(new CallbackError(kind, "delivery")),
      "permanent",
    );
  }
});

Deno.test("classifyModelError classifies the first-emission protocol failure permanent", () => {
  assertEquals(
    classifyModelError(new ProtocolError("protocol failure: role mismatch")),
    "permanent",
  );
});

Deno.test("classifyModelError treats non-Error throwables like their text", () => {
  assertEquals(classifyModelError("rate limited"), "transient");
  assertEquals(classifyModelError("401 unauthorized"), "permanent");
  assertEquals(classifyModelError(42), "transient"); // unknown → transient
});

// ---------------------------------------------------------------------------
// runWithRetries — bounded attempts, backoff, and error propagation
// ---------------------------------------------------------------------------

Deno.test("runWithRetries retries transient failures until fn succeeds", async () => {
  const { deps, sleeps } = fakeDeps();
  let calls = 0;
  const failure = new Error("429 rate limited");
  const result = await runWithRetries(
    () => {
      calls += 1;
      if (calls <= 2) return Promise.reject(failure);
      return Promise.resolve("ok");
    },
    { retries: 3 },
    deps,
  );

  assertEquals(result, "ok");
  assertEquals(calls, 3);
  // Backoff sequence: 250 × [1, 2] × 0.5 jitter (random() = 0 → factor 0.5).
  assertEquals(sleeps, [BACKOFF_BASE_MS * 0.5, BACKOFF_BASE_MS * 2 * 0.5]);
});

Deno.test("runWithRetries performs at most `retries` additional attempts", async () => {
  const { deps, sleeps } = fakeDeps();
  let calls = 0;
  const last = new Error("overloaded");
  let thrown: unknown;
  try {
    await runWithRetries(
      () => {
        calls += 1;
        return Promise.reject(last);
      },
      { retries: 2 },
      deps,
    );
  } catch (error) {
    thrown = error;
  }

  assertEquals(calls, 3); // initial + 2 retries
  assertEquals(sleeps.length, 2);
  // Exhaustion rethrows the last error unchanged (same instance).
  assertEquals(thrown, last);
});

Deno.test("runWithRetries with retries: 0 disables retrying", async () => {
  const { deps, sleeps } = fakeDeps();
  let calls = 0;
  let thrown: unknown;
  try {
    await runWithRetries(
      () => {
        calls += 1;
        return Promise.reject(new Error("429"));
      },
      { retries: 0 },
      deps,
    );
  } catch (error) {
    thrown = error;
  }

  assertEquals(calls, 1);
  assertEquals(sleeps, []);
  assertEquals((thrown as Error).message, "429");
});

Deno.test("runWithRetries short-circuits a permanent error immediately", async () => {
  const { deps, sleeps } = fakeDeps();
  let calls = 0;
  const permanent = new Error("invalid api key");
  let thrown: unknown;
  try {
    await runWithRetries(
      () => {
        calls += 1;
        return Promise.reject(permanent);
      },
      { retries: 5 },
      deps,
    );
  } catch (error) {
    thrown = error;
  }

  assertEquals(calls, 1);
  assertEquals(sleeps, []);
  assertEquals(thrown, permanent);
});

Deno.test("runWithRetries never retries CallbackError or ProtocolError", async () => {
  for (
    const error of [
      new CallbackError("conflict", "409"),
      new ProtocolError("protocol failure: role mismatch"),
    ]
  ) {
    const { deps, sleeps } = fakeDeps();
    let calls = 0;
    let thrown: unknown;
    try {
      await runWithRetries(
        () => {
          calls += 1;
          return Promise.reject(error);
        },
        { retries: 3 },
        deps,
      );
    } catch (caught) {
      thrown = caught;
    }
    assertEquals(calls, 1);
    assertEquals(sleeps, []);
    assertEquals(thrown, error);
  }
});

Deno.test("runWithRetries caps the backoff at BACKOFF_CAP_MS with jitter", async () => {
  // random() = 0 → the jitter factor is exactly 0.5, so the sleep sequence
  // exposes the base backoff: 125, 250, 500, 1000, 2000, then capped at
  // 2500 (5000 × 0.5) from the sixth retry onward.
  const { deps, sleeps } = fakeDeps();
  let calls = 0;
  await runWithRetries(
    () => {
      calls += 1;
      if (calls <= 8) return Promise.reject(new Error("overloaded"));
      return Promise.resolve("done");
    },
    { retries: 10 },
    deps,
  );

  assertEquals(calls, 9);
  assertEquals(sleeps, [125, 250, 500, 1000, 2000, 2500, 2500, 2500]);
  assertEquals(Math.max(...sleeps), BACKOFF_CAP_MS * 0.5);
});

Deno.test("runWithRetries scales the backoff by the injected random value", async () => {
  // jitter factor = 0.5 + random() × 0.5; sequence [0, 0.5, 0.75] gives
  // factors 0.5, 0.75, 0.875 over the bases 250, 500, 1000.
  const randoms = [0, 0.5, 0.75];
  let next = 0;
  const { deps, sleeps } = fakeDeps({ random: () => randoms[next++]! });
  let calls = 0;
  await runWithRetries(
    () => {
      calls += 1;
      if (calls <= 3) return Promise.reject(new Error("timeout"));
      return Promise.resolve("done");
    },
    { retries: 3 },
    deps,
  );

  assertEquals(sleeps, [125, 375, 875]);
});

Deno.test("runWithRetries reports each retry through the onRetry hook", async () => {
  const { deps } = fakeDeps();
  const notices: { attempt: number; backoffMs: number; message: string }[] = [];
  let calls = 0;
  await runWithRetries(
    () => {
      calls += 1;
      if (calls <= 2) return Promise.reject(new Error(`blip ${calls}`));
      return Promise.resolve("ok");
    },
    {
      retries: 2,
      onRetry: ({ attempt, backoffMs, error }) =>
        notices.push({
          attempt,
          backoffMs,
          message: (error as Error).message,
        }),
    },
    deps,
  );

  assertEquals(notices, [
    { attempt: 1, backoffMs: 125, message: "blip 1" },
    { attempt: 2, backoffMs: 250, message: "blip 2" },
  ]);
});

// ---------------------------------------------------------------------------
// runWithRetries — deadline cutoff
// ---------------------------------------------------------------------------

Deno.test("runWithRetries does not start a retry when the clock is past the cutoff", async () => {
  // The clock starts past the cutoff: the first failure ends the loop before
  // any backoff is computed.
  const { deps, sleeps } = fakeDeps({ initialMs: 1_000 });
  let calls = 0;
  let thrown: unknown;
  try {
    await runWithRetries(
      () => {
        calls += 1;
        return Promise.reject(new Error("429"));
      },
      { retries: 3, cutoffMs: 500 },
      deps,
    );
  } catch (error) {
    thrown = error;
  }

  assertEquals(calls, 1);
  assertEquals(sleeps, []);
  assertEquals((thrown as Error).message, "429");
});

Deno.test("runWithRetries stops after a backoff sleep that consumed the cutoff", async () => {
  // cutoff 1000 ms: attempts start at 0, 125, 375, 875; the sleep after the
  // fourth failure reaches 1875 ≥ 1000, so no fifth attempt starts.
  const { deps, sleeps, clock } = fakeDeps();
  let calls = 0;
  let thrown: unknown;
  try {
    await runWithRetries(
      () => {
        calls += 1;
        return Promise.reject(new Error("429"));
      },
      { retries: 99, cutoffMs: 1_000 },
      deps,
    );
  } catch (error) {
    thrown = error;
  }

  assertEquals(calls, 4);
  assertEquals(sleeps, [125, 250, 500, 1000]);
  assertEquals(clock(), 1_875);
  assertEquals((thrown as Error).message, "429");
});

Deno.test("runWithRetries defaults to production timing deps", async () => {
  // No deps argument: the loop must still work (real sleep of 125ms once).
  const start = Date.now();
  let calls = 0;
  await runWithRetries(
    () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("429"));
      return Promise.resolve("ok");
    },
    { retries: 1 },
  );
  assertEquals(calls, 2);
  assertEquals(Date.now() - start >= 125, true);
  // Sanity: the exported production deps expose the expected sources.
  assertEquals(typeof productionRetryDeps.random(), "number");
  assertEquals(productionRetryDeps.now() instanceof Date, true);
});