import type { ModelUsage } from "@huuma/ai/agent";
import { assertEquals } from "@std/assert";
import {
  ManagedUsageTracker,
  parseAuxvClockTicks,
  parseProcSelfStat,
  type ProcessCpuSnapshot,
  type ProcessRamSnapshot,
  type UsageSampler,
} from "./usage.ts";

function queueSampler(options: {
  cpu: (ProcessCpuSnapshot | Error)[];
  ram: (ProcessRamSnapshot | Error)[];
}): UsageSampler {
  const cpu = [...options.cpu];
  const ram = [...options.ram];
  return {
    sampleCpu: () => {
      const next = cpu.shift();
      if (next === undefined) throw new Error("CPU sample queue exhausted");
      if (next instanceof Error) throw next;
      return next;
    },
    sampleRam: () => {
      const next = ram.shift();
      if (next === undefined) throw new Error("RAM sample queue exhausted");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

Deno.test("parseProcSelfStat uses the host tick rate for self and child CPU", () => {
  const stat = "123 (worker with spaces) R 1 2 3 4 5 6 7 8 9 10 11 12 13 14";
  assertEquals(parseProcSelfStat(stat, 250), {
    userMs: 96,
    systemMs: 104,
  });
});

Deno.test("parseAuxvClockTicks reads AT_CLKTCK from 64-bit Linux auxv", () => {
  const auxv = new Uint8Array(32);
  const view = new DataView(auxv.buffer);
  view.setBigUint64(0, 17n, true);
  view.setBigUint64(8, 250n, true);
  // The second zero-filled entry is AT_NULL.
  assertEquals(parseAuxvClockTicks(auxv, 8, true), 250);
});

Deno.test("ManagedUsageTracker attributes token deltas and resource samples per message", async () => {
  const errors: string[] = [];
  const tracker = new ManagedUsageTracker({
    model: "claude-haiku-4-5",
    sampler: queueSampler({
      cpu: [
        { userMs: 100, systemMs: 50 },
        { userMs: 112, systemMs: 53 },
        { userMs: 120, systemMs: 60 },
        { userMs: 125, systemMs: 65 },
        { userMs: 130, systemMs: 70 },
      ],
      ram: [
        { rssBytes: 1_000, heapUsedBytes: 400 },
        { rssBytes: 1_200, heapUsedBytes: 500 },
        { rssBytes: 1_100, heapUsedBytes: 450 },
      ],
    }),
    onError: (section, error) => errors.push(`${section}:${String(error)}`),
  });

  await tracker.start();
  tracker.beginAttempt();
  const firstSnapshot: ModelUsage = {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
  };
  assertEquals(await tracker.messageUsage(firstSnapshot), {
    tokens: {
      model: "claude-haiku-4-5",
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    },
    cpu: { userMs: 12, systemMs: 3, totalMs: 15 },
    ram: { rssBytes: 1_000, heapUsedBytes: 400, peakRssBytes: 1_000 },
  });

  // Tool messages receive the same accumulated snapshot. No token delta means
  // the tokens section is absent while CPU and RAM remain attributable.
  assertEquals(await tracker.messageUsage(firstSnapshot), {
    cpu: { userMs: 8, systemMs: 7, totalMs: 15 },
    ram: { rssBytes: 1_200, heapUsedBytes: 500, peakRssBytes: 1_200 },
  });

  assertEquals(
    await tracker.messageUsage({
      inputTokens: 150,
      outputTokens: 30,
      totalTokens: 180,
    }),
    {
      tokens: {
        model: "claude-haiku-4-5",
        inputTokens: 50,
        outputTokens: 10,
        totalTokens: 60,
      },
      cpu: { userMs: 5, systemMs: 5, totalMs: 10 },
      ram: { rssBytes: 1_100, heapUsedBytes: 450, peakRssBytes: 1_200 },
    },
  );
  tracker.endAttempt();

  assertEquals(await tracker.turnUsage(), {
    tokens: {
      model: "claude-haiku-4-5",
      inputTokens: 150,
      outputTokens: 30,
      totalTokens: 180,
    },
    cpu: { userMs: 30, systemMs: 20, totalMs: 50 },
    ram: { peakRssBytes: 1_200 },
  });
  assertEquals(errors, []);
});

Deno.test("ManagedUsageTracker resets token deltas and sums final snapshots across attempts", async () => {
  const tracker = new ManagedUsageTracker({
    model: "model-1",
    sampler: queueSampler({
      cpu: [
        { userMs: 0, systemMs: 0 },
        { userMs: 1, systemMs: 1 },
        { userMs: 2, systemMs: 2 },
        { userMs: 3, systemMs: 3 },
      ],
      ram: [
        { rssBytes: 100, heapUsedBytes: 50 },
        { rssBytes: 110, heapUsedBytes: 55 },
      ],
    }),
    onError: () => {},
  });
  await tracker.start();

  tracker.beginAttempt();
  assertEquals(await tracker.messageUsage({ totalTokens: 100 }), {
    tokens: { model: "model-1", totalTokens: 100 },
    cpu: { userMs: 1, systemMs: 1, totalMs: 2 },
    ram: { rssBytes: 100, heapUsedBytes: 50, peakRssBytes: 100 },
  });
  tracker.endAttempt();

  tracker.beginAttempt();
  assertEquals(await tracker.messageUsage({ totalTokens: 40 }), {
    tokens: { model: "model-1", totalTokens: 40 },
    cpu: { userMs: 1, systemMs: 1, totalMs: 2 },
    ram: { rssBytes: 110, heapUsedBytes: 55, peakRssBytes: 110 },
  });
  tracker.endAttempt();

  assertEquals(await tracker.turnUsage(), {
    tokens: { model: "model-1", totalTokens: 140 },
    cpu: { userMs: 3, systemMs: 3, totalMs: 6 },
    ram: { peakRssBytes: 110 },
  });
});

Deno.test("ManagedUsageTracker bounds slow samples and continues composing usage", async () => {
  let cpuSamples = 0;
  const errors: string[] = [];
  const tracker = new ManagedUsageTracker({
    model: "model-1",
    sampler: {
      sampleCpu: () => {
        cpuSamples += 1;
        if (cpuSamples === 1) return { userMs: 0, systemMs: 0 };
        return new Promise<ProcessCpuSnapshot>(() => {});
      },
      sampleRam: () => ({ rssBytes: 100, heapUsedBytes: 50 }),
    },
    onError: (section, error) =>
      errors.push(`${section}:${(error as Error).message}`),
  });
  await tracker.start();
  tracker.beginAttempt();

  let guard: ReturnType<typeof setTimeout> | undefined;
  const usage = await Promise.race([
    tracker.messageUsage({ totalTokens: 5 }),
    new Promise<never>((_, reject) => {
      guard = setTimeout(
        () => reject(new Error("usage composition did not finish")),
        500,
      );
    }),
  ]).finally(() => {
    if (guard !== undefined) clearTimeout(guard);
  });
  assertEquals(usage, {
    tokens: { model: "model-1", totalTokens: 5 },
    ram: { rssBytes: 100, heapUsedBytes: 50, peakRssBytes: 100 },
  });
  assertEquals(errors, ["cpu:CPU sampling timed out after 25ms"]);
});

Deno.test("ManagedUsageTracker contains sampling failures and omits only unavailable sections", async () => {
  const errors: string[] = [];
  const tracker = new ManagedUsageTracker({
    model: "model-1",
    sampler: queueSampler({
      cpu: [new Error("proc unavailable")],
      ram: [
        new Error("memory sample failed"),
        { rssBytes: 200, heapUsedBytes: 80 },
      ],
    }),
    onError: (section, error) =>
      errors.push(`${section}:${(error as Error).message}`),
  });

  await tracker.start();
  tracker.beginAttempt();
  assertEquals(await tracker.messageUsage({ totalTokens: 10 }), {
    tokens: { model: "model-1", totalTokens: 10 },
  });
  assertEquals(await tracker.messageUsage({ totalTokens: 10 }), {
    ram: { rssBytes: 200, heapUsedBytes: 80, peakRssBytes: 200 },
  });
  tracker.endAttempt();
  assertEquals(await tracker.turnUsage(), {
    tokens: { model: "model-1", totalTokens: 10 },
    ram: { peakRssBytes: 200 },
  });
  assertEquals(errors, [
    "cpu:proc unavailable",
    "ram:memory sample failed",
  ]);
});
