/**
 * Tests for the Turn-scoped usage tracker (spec 106, ADR 0011).
 *
 * All sampling sources are injected, so delta attribution, attempt resets,
 * Turn summaries, and the fail-safe degradation rules are fully
 * deterministic. `readCpu`/`readRam` are driven from scripted queues.
 */
import { assertEquals } from "@std/assert";
import type { ModelUsage } from "@huuma/ai/agent";
import {
  type CpuCounters,
  productionUsageDeps,
  type UsageDeps,
  UsageTracker,
} from "./usage.ts";

/** Scripted sampling sources. Each read shifts the next queued value; CPU
 * entries may be `undefined` (unavailable) or an Error (sampling failure). */
function makeDeps(opts: {
  cpu?: (CpuCounters | undefined | Error)[];
  ram?: ({ rssBytes: number; heapUsedBytes: number } | Error)[];
} = {}) {
  const logged: string[] = [];
  const cpuQueue = [...(opts.cpu ?? [])];
  const ramQueue = [...(opts.ram ?? [])];
  const deps: UsageDeps = {
    readCpu: () => {
      // An exhausted queue returns a stable zero sample; a queued explicit
      // `undefined` models "/proc unavailable" (distinct from empty).
      if (cpuQueue.length === 0) return { userTicks: 0, systemTicks: 0 };
      const next = cpuQueue.shift();
      if (next === undefined) return undefined;
      if (next instanceof Error) throw next;
      return next;
    },
    readRam: () => {
      const next = ramQueue.shift();
      if (next === undefined) return { rssBytes: 0, heapUsedBytes: 0 };
      if (next instanceof Error) throw next;
      return next;
    },
    logError: (message) => logged.push(message),
  };
  return { deps, logged, cpuQueue, ramQueue };
}

const MODEL = "claude-haiku-4-5";

Deno.test("model messages report snapshot deltas; unchanged snapshots omit tokens", () => {
  const { deps } = makeDeps();
  const tracker = new UsageTracker(deps, MODEL);
  tracker.start();

  // First model message: the whole accumulated snapshot is attributable.
  const first = tracker.messageUsage({ inputTokens: 100, outputTokens: 40 });
  assertEquals(first?.tokens, {
    model: MODEL,
    inputTokens: 100,
    outputTokens: 40,
  });

  // Second model message: only the delta since the previous snapshot.
  const second = tracker.messageUsage({
    inputTokens: 250,
    outputTokens: 90,
    thinkingTokens: 10,
  });
  assertEquals(second?.tokens, {
    model: MODEL,
    inputTokens: 150,
    outputTokens: 50,
    thinkingTokens: 10,
  });

  // Tool message: same accumulated snapshot → no model call → no tokens.
  const tool = tracker.messageUsage({
    inputTokens: 250,
    outputTokens: 90,
    thinkingTokens: 10,
  });
  assertEquals(tool?.tokens, undefined);

  // A batch's later model messages carry the same snapshot → no tokens.
  const batchSecond = tracker.messageUsage({
    inputTokens: 250,
    outputTokens: 90,
    thinkingTokens: 10,
  });
  assertEquals(batchSecond?.tokens, undefined);
});

Deno.test("a snapshot without any reported field omits tokens", () => {
  const { deps } = makeDeps();
  const tracker = new UsageTracker(deps, MODEL);
  tracker.start();
  const first = tracker.messageUsage({ inputTokens: 12 });
  assertEquals(first?.tokens, { model: MODEL, inputTokens: 12 });
  // sumModelUsage collapses a usage report without fields to undefined, so
  // the next emission receives undefined — nothing attributable.
  assertEquals(tracker.messageUsage(undefined)?.tokens, undefined);
});

Deno.test("the model identifier is omitted when unknown", () => {
  const { deps } = makeDeps();
  const tracker = new UsageTracker(deps);
  tracker.start();
  const first = tracker.messageUsage({ totalTokens: 7 });
  assertEquals(first?.tokens, { totalTokens: 7 });
});

Deno.test("the token baseline resets per attempt and the summary sums attempt finals", () => {
  const { deps } = makeDeps();
  const tracker = new UsageTracker(deps, MODEL);
  tracker.start();

  // Attempt 1: one model call, then a transient failure.
  const attempt1 = tracker.messageUsage({ inputTokens: 100, outputTokens: 40 });
  assertEquals(attempt1?.tokens?.inputTokens, 100);
  tracker.resetAttempt();

  // Attempt 2: the baseline has reset, so the first message of the attempt
  // carries that attempt's whole usage — not a delta against attempt 1.
  const attempt2 = tracker.messageUsage({ inputTokens: 30, outputTokens: 12 });
  assertEquals(attempt2?.tokens, { model: MODEL, inputTokens: 30, outputTokens: 12 });
  const attempt2Second = tracker.messageUsage({
    inputTokens: 60,
    outputTokens: 25,
  });
  assertEquals(attempt2Second?.tokens, {
    model: MODEL,
    inputTokens: 30,
    outputTokens: 13,
  });

  // The Turn summary sums every attempt's final snapshot: attempt 1's final
  // (100/40) + attempt 2's final (60/25) = 160/65.
  const summary = tracker.turnSummary();
  assertEquals(summary?.tokens, {
    model: MODEL,
    inputTokens: 160,
    outputTokens: 65,
  });
  // Idempotent: a second read reports the same totals.
  assertEquals(tracker.turnSummary()?.tokens, {
    model: MODEL,
    inputTokens: 160,
    outputTokens: 65,
  });
});

Deno.test("an attempt that reports no usage contributes nothing to the summary", () => {
  const { deps } = makeDeps();
  const tracker = new UsageTracker(deps, MODEL);
  tracker.start();
  tracker.messageUsage({ inputTokens: 100 });
  tracker.resetAttempt();
  // Attempt 2 fails before any model call reports usage.
  tracker.resetAttempt();
  tracker.messageUsage({ inputTokens: 25 });
  assertEquals(tracker.turnSummary()?.tokens?.inputTokens, 125);
});

Deno.test("CPU deltas run from turn.running through every emission and across attempts", () => {
  // One tick = 10 ms (CLK_TCK = 100).
  const { deps } = makeDeps({
    cpu: [
      { userTicks: 10, systemTicks: 2 }, // start (turn.running baseline)
      { userTicks: 93, systemTicks: 23 }, // message 1: user 830ms, system 210ms
      { userTicks: 95, systemTicks: 23 }, // message 2: user 20ms, system 0ms
      { userTicks: 95, systemTicks: 23 }, // first message after retry: 0/0
      { userTicks: 95, systemTicks: 23 }, // turn summary sample
    ],
    ram: [{ rssBytes: 1, heapUsedBytes: 1 }],
  });
  const tracker = new UsageTracker(deps, MODEL);
  tracker.start();
  assertEquals(tracker.messageUsage(undefined)?.cpu, {
    userMs: 830,
    systemMs: 210,
    totalMs: 1040,
  });
  assertEquals(tracker.messageUsage(undefined)?.cpu, {
    userMs: 20,
    systemMs: 0,
    totalMs: 20,
  });

  // CPU baselines continue across retry attempts (monotone counters).
  tracker.resetAttempt();
  const afterRetry = tracker.messageUsage(undefined);
  assertEquals(afterRetry?.cpu, { userMs: 0, systemMs: 0, totalMs: 0 });

  // The Turn summary reports the cumulative CPU since turn.running.
  const summary = tracker.turnSummary();
  assertEquals(summary?.cpu, { userMs: 850, systemMs: 210, totalMs: 1060 });
});

Deno.test("cpu is omitted when /proc is unavailable", () => {
  const { deps } = makeDeps({
    cpu: [undefined, undefined],
    ram: [{ rssBytes: 1, heapUsedBytes: 1 }, { rssBytes: 1, heapUsedBytes: 1 }],
  });
  const tracker = new UsageTracker(deps, MODEL);
  tracker.start();
  const usage = tracker.messageUsage(undefined);
  assertEquals(usage?.cpu, undefined);
  assertEquals(usage?.ram, {
    rssBytes: 1,
    heapUsedBytes: 1,
    peakRssBytes: 1,
  });
  assertEquals(tracker.turnSummary()?.cpu, undefined);
});

Deno.test("a backwards CPU counter omits the section instead of fabricating a delta", () => {
  const { deps } = makeDeps({
    cpu: [
      { userTicks: 50, systemTicks: 10 },
      { userTicks: 40, systemTicks: 10 }, // counters went backwards
    ],
    ram: [{ rssBytes: 1, heapUsedBytes: 1 }],
  });
  const tracker = new UsageTracker(deps, MODEL);
  tracker.start();
  assertEquals(tracker.messageUsage(undefined)?.cpu, undefined);
});

Deno.test("RAM gauges report current values and a Turn-scoped peak of samples", () => {
  const { deps } = makeDeps({
    ram: [
      { rssBytes: 100, heapUsedBytes: 40 },
      { rssBytes: 130, heapUsedBytes: 50 },
      { rssBytes: 90, heapUsedBytes: 30 },
    ],
  });
  const tracker = new UsageTracker(deps, MODEL);
  tracker.start();
  assertEquals(tracker.messageUsage(undefined)?.ram, {
    rssBytes: 100,
    heapUsedBytes: 40,
    peakRssBytes: 100,
  });
  assertEquals(tracker.messageUsage(undefined)?.ram, {
    rssBytes: 130,
    heapUsedBytes: 50,
    peakRssBytes: 130,
  });
  // The peak survives a later dip — it is the Turn-scoped maximum.
  const third = tracker.messageUsage(undefined);
  assertEquals(third?.ram, {
    rssBytes: 90,
    heapUsedBytes: 30,
    peakRssBytes: 130,
  });
  // The Turn summary carries the final peak, and the peak stays Turn-scoped
  // across attempt resets.
  tracker.resetAttempt();
  assertEquals(tracker.turnSummary()?.ram?.peakRssBytes, 130);
});

Deno.test("sampling failures are logged and degrade to omitted sections only", () => {
  const { deps, logged } = makeDeps({
    cpu: [new Error("proc read failed")],
    ram: [new Error("memoryUsage exploded")],
  });
  const tracker = new UsageTracker(deps, MODEL);
  tracker.start();
  // Tokens still compose; only the failing sections are omitted.
  const usage = tracker.messageUsage({ inputTokens: 5 });
  assertEquals(usage, { tokens: { model: MODEL, inputTokens: 5 } });
  assertEquals(logged.some((l) => l.includes("[managed:usage.cpu")), true);
  assertEquals(logged.some((l) => l.includes("[managed:usage.ram]")), true);
});

Deno.test("a total sampling failure omits usage entirely and never throws", () => {
  const { deps, logged } = makeDeps({
    cpu: [
      new Error("cpu down"),
      new Error("cpu down"),
      new Error("cpu down"),
    ],
    ram: [new Error("ram down"), new Error("ram down")],
  });
  const tracker = new UsageTracker(deps, MODEL);
  tracker.start();
  assertEquals(tracker.messageUsage(undefined), undefined);
  assertEquals(tracker.turnSummary(), undefined);
  // cpu at start, cpu+ram at the emission, cpu+ram at the summary.
  assertEquals(logged.length, 5);
});

Deno.test("turnSummary folds the current attempt exactly once", () => {
  const { deps } = makeDeps({
    cpu: [{ userTicks: 1, systemTicks: 0 }, { userTicks: 2, systemTicks: 0 }],
    ram: [{ rssBytes: 10, heapUsedBytes: 5 }],
  });
  const tracker = new UsageTracker(deps, MODEL);
  tracker.start();
  tracker.messageUsage({ inputTokens: 10 });
  // No resetAttempt before the summary — the final attempt folds in place.
  assertEquals(tracker.turnSummary()?.tokens, {
    model: MODEL,
    inputTokens: 10,
  });
  // Repeated summaries never double-count.
  assertEquals(tracker.turnSummary()?.tokens?.inputTokens, 10);
});

Deno.test("production deps read real gauges on Linux and never throw", () => {
  const logged: string[] = [];
  const deps = productionUsageDeps((m) => logged.push(m));
  const cpu = deps.readCpu();
  // Sandboxes are Linux: /proc is available. macOS dev omits the section.
  if (cpu !== undefined) {
    assertEquals(cpu.userTicks >= 0, true);
    assertEquals(cpu.systemTicks >= 0, true);
  }
  const ram = deps.readRam();
  assertEquals(ram.rssBytes > 0, true);
  assertEquals(ram.heapUsedBytes > 0, true);
  assertEquals(logged, []);
});

Deno.test("token deltas clamp a negative field instead of fabricating a decrease", () => {
  const { deps } = makeDeps();
  const tracker = new UsageTracker(deps, MODEL);
  tracker.start();
  tracker.messageUsage({ inputTokens: 100, outputTokens: 40 });
  // A snapshot that went "backwards" (impossible in practice) clamps to zero
  // rather than reporting a negative token count.
  const usage = tracker.messageUsage({ inputTokens: 80, outputTokens: 40 });
  assertEquals(usage?.tokens?.inputTokens, 0);
});