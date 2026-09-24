import { type ModelUsage, sumModelUsage } from "@huuma/ai/agent";

/** Token usage attributed to one emitted message or summarized for a Turn.
 * Fields retain `ModelUsage`'s "absent means not reported" semantics. */
export interface ManagedTokenUsage extends ModelUsage {
  /** Model identifier used for the calls represented by this usage block. */
  model?: string;
}

/** Process CPU consumed during an interval, in milliseconds. */
export interface ManagedCpuUsage {
  userMs: number;
  systemMs: number;
  totalMs: number;
}

/** Process memory gauges sampled when a message is emitted. */
export interface ManagedMessageRamUsage {
  rssBytes: number;
  heapUsedBytes: number;
  /** Highest sampled RSS for the Turn through this emission. */
  peakRssBytes: number;
}

/** Usage attributable to one `message.appended` event. Every section is
 * optional so unavailable telemetry can be omitted without blocking delivery. */
export interface ManagedMessageUsage {
  tokens?: ManagedTokenUsage;
  cpu?: ManagedCpuUsage;
  ram?: ManagedMessageRamUsage;
}

/** Turn-total usage attached to `turn.finished`. */
export interface ManagedTurnUsage {
  tokens?: ManagedTokenUsage;
  cpu?: ManagedCpuUsage;
  ram?: {
    /** Highest RSS sampled at a message-emission boundary during the Turn. */
    peakRssBytes: number;
  };
}

/** Monotonic process CPU counters used to derive per-emission deltas. */
export interface ProcessCpuSnapshot {
  userMs: number;
  systemMs: number;
}

/** Process memory gauges sampled at one emission boundary. */
export interface ProcessRamSnapshot {
  rssBytes: number;
  heapUsedBytes: number;
}

/** Injectable platform samplers for deterministic managed-runner tests. */
export interface UsageSampler {
  sampleCpu: () => ProcessCpuSnapshot | Promise<ProcessCpuSnapshot>;
  sampleRam: () => ProcessRamSnapshot | Promise<ProcessRamSnapshot>;
}

/** Linux exposes process CPU counters in clock ticks. Huuma sandboxes use the
 * conventional 100 Hz clock, so each tick represents 10 milliseconds. */
const LINUX_CLOCK_TICKS_PER_SECOND = 100;
const MODEL_USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "thinkingTokens",
] as const satisfies readonly (keyof ModelUsage)[];

/** Production sampler used by managed CLI invocations. CPU includes the runner
 * plus reaped children (`utime + cutime`, `stime + cstime`). */
export const productionUsageSampler: UsageSampler = {
  sampleCpu: async () =>
    parseProcSelfStat(await Deno.readTextFile("/proc/self/stat")),
  sampleRam: () => {
    const memory = Deno.memoryUsage();
    return { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed };
  },
};

/** Parses Linux `/proc/self/stat` into millisecond CPU counters. The process
 * name is parenthesized and may contain spaces, so fields are split only after
 * its final closing parenthesis. */
export function parseProcSelfStat(stat: string): ProcessCpuSnapshot {
  const commEnd = stat.lastIndexOf(")");
  if (commEnd < 0) {
    throw new Error("invalid /proc/self/stat: missing process name terminator");
  }
  const fields = stat.slice(commEnd + 1).trim().split(/\s+/);
  // fields[0] is field 3 (`state`); utime/stime/cutime/cstime are fields 14–17.
  if (fields.length < 15) {
    throw new Error("invalid /proc/self/stat: missing CPU fields");
  }
  const utime = parseCounter(fields[11], "utime");
  const stime = parseCounter(fields[12], "stime");
  const cutime = parseCounter(fields[13], "cutime");
  const cstime = parseCounter(fields[14], "cstime");
  const millisecondsPerTick = 1000 / LINUX_CLOCK_TICKS_PER_SECOND;
  return {
    userMs: (utime + cutime) * millisecondsPerTick,
    systemMs: (stime + cstime) * millisecondsPerTick,
  };
}

/** Accumulates retry-aware token totals and composes best-effort resource usage
 * at managed callback emission boundaries. Sampling failures are contained and
 * reported through `onError`; they never reject message delivery. */
export class ManagedUsageTracker {
  private readonly model: string | undefined;
  private readonly sampler: UsageSampler;
  private readonly onError: (
    section: "tokens" | "cpu" | "ram",
    error: unknown,
  ) => void;
  private attemptPreviousTokens: ModelUsage | undefined;
  private attemptLastTokens: ModelUsage | undefined;
  private turnTokens: ModelUsage | undefined;
  private cpuStart: ProcessCpuSnapshot | undefined;
  private cpuPrevious: ProcessCpuSnapshot | undefined;
  private cpuAvailable = true;
  private peakRssBytes: number | undefined;

  constructor(options: {
    model?: string;
    sampler: UsageSampler;
    onError: (
      section: "tokens" | "cpu" | "ram",
      error: unknown,
    ) => void;
  }) {
    this.model = options.model;
    this.sampler = options.sampler;
    this.onError = options.onError;
  }

  /** Captures the CPU baseline immediately after `turn.running` is
   * acknowledged. A failure disables CPU telemetry for the remainder of the
   * Turn because later deltas could no longer be attributed accurately. */
  async start(): Promise<void> {
    try {
      const snapshot = validateCpuSnapshot(await this.sampler.sampleCpu());
      this.cpuStart = snapshot;
      this.cpuPrevious = snapshot;
    } catch (error) {
      this.cpuAvailable = false;
      this.onError("cpu", error);
    }
  }

  /** Resets the accumulated-token delta baseline for a new `agent.run`
   * attempt. CPU and RAM remain Turn-scoped across retries. */
  beginAttempt(): void {
    this.attemptPreviousTokens = undefined;
    this.attemptLastTokens = undefined;
  }

  /** Adds the attempt's final accumulated token snapshot to the Turn total. */
  endAttempt(): void {
    this.turnTokens = sumModelUsage(this.turnTokens, this.attemptLastTokens);
  }

  /** Composes usage for one emitted message. Each section is isolated so a
   * failed sample only omits that section. */
  async messageUsage(
    accumulatedTokens?: ModelUsage,
  ): Promise<ManagedMessageUsage | undefined> {
    const usage: ManagedMessageUsage = {};

    try {
      const tokens = this.tokenDelta(accumulatedTokens);
      if (tokens !== undefined) usage.tokens = tokens;
    } catch (error) {
      this.onError("tokens", error);
    }

    const [cpu, ram] = await Promise.all([
      this.sampleCpuDelta(),
      this.sampleRam(),
    ]);
    if (cpu !== undefined) usage.cpu = cpu;
    if (ram !== undefined) usage.ram = ram;

    return hasUsage(usage) ? usage : undefined;
  }

  /** Composes the successful Turn summary after the final attempt has ended. */
  async turnUsage(): Promise<ManagedTurnUsage | undefined> {
    const usage: ManagedTurnUsage = {};
    if (this.turnTokens !== undefined) {
      usage.tokens = withModel(this.turnTokens, this.model);
    }

    const cpu = await this.sampleTurnCpu();
    if (cpu !== undefined) usage.cpu = cpu;
    if (this.peakRssBytes !== undefined) {
      usage.ram = { peakRssBytes: this.peakRssBytes };
    }

    return hasUsage(usage) ? usage : undefined;
  }

  private tokenDelta(
    accumulatedTokens?: ModelUsage,
  ): ManagedTokenUsage | undefined {
    if (accumulatedTokens === undefined) return undefined;
    const current = validateModelUsage(accumulatedTokens);
    const previous = this.attemptPreviousTokens;
    this.attemptPreviousTokens = current;
    this.attemptLastTokens = current;

    const delta: ModelUsage = {};
    for (const key of MODEL_USAGE_KEYS) {
      const value = current[key];
      if (value === undefined) continue;
      const prior = previous?.[key];
      const difference = value - (prior ?? 0);
      if (difference < 0) {
        throw new Error(`accumulated token usage decreased for ${key}`);
      }
      if (prior === undefined || difference !== 0) delta[key] = difference;
    }
    return Object.keys(delta).length === 0
      ? undefined
      : withModel(delta, this.model);
  }

  private async sampleCpuDelta(): Promise<ManagedCpuUsage | undefined> {
    if (!this.cpuAvailable || this.cpuPrevious === undefined) return undefined;
    try {
      const current = validateCpuSnapshot(await this.sampler.sampleCpu());
      const usage = cpuDelta(this.cpuPrevious, current);
      this.cpuPrevious = current;
      return usage;
    } catch (error) {
      // A missing sample destroys the per-message attribution boundary. Do not
      // resume and incorrectly charge the skipped interval to a later message.
      this.cpuAvailable = false;
      this.onError("cpu", error);
      return undefined;
    }
  }

  private async sampleTurnCpu(): Promise<ManagedCpuUsage | undefined> {
    if (!this.cpuAvailable || this.cpuStart === undefined) return undefined;
    try {
      return cpuDelta(
        this.cpuStart,
        validateCpuSnapshot(await this.sampler.sampleCpu()),
      );
    } catch (error) {
      this.cpuAvailable = false;
      this.onError("cpu", error);
      return undefined;
    }
  }

  private async sampleRam(): Promise<ManagedMessageRamUsage | undefined> {
    try {
      const current = validateRamSnapshot(await this.sampler.sampleRam());
      this.peakRssBytes = Math.max(this.peakRssBytes ?? 0, current.rssBytes);
      return { ...current, peakRssBytes: this.peakRssBytes };
    } catch (error) {
      this.onError("ram", error);
      return undefined;
    }
  }
}

function parseCounter(raw: string | undefined, name: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`invalid /proc/self/stat ${name} counter`);
  }
  return value;
}

function validateCpuSnapshot(snapshot: ProcessCpuSnapshot): ProcessCpuSnapshot {
  return {
    userMs: nonNegativeFinite(snapshot.userMs, "CPU userMs"),
    systemMs: nonNegativeFinite(snapshot.systemMs, "CPU systemMs"),
  };
}

function validateRamSnapshot(snapshot: ProcessRamSnapshot): ProcessRamSnapshot {
  return {
    rssBytes: nonNegativeFinite(snapshot.rssBytes, "RAM rssBytes"),
    heapUsedBytes: nonNegativeFinite(
      snapshot.heapUsedBytes,
      "RAM heapUsedBytes",
    ),
  };
}

function validateModelUsage(usage: ModelUsage): ModelUsage {
  const copy: ModelUsage = {};
  for (const key of MODEL_USAGE_KEYS) {
    const value = usage[key];
    if (value !== undefined) copy[key] = nonNegativeFinite(value, key);
  }
  return copy;
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
  return value;
}

function cpuDelta(
  previous: ProcessCpuSnapshot,
  current: ProcessCpuSnapshot,
): ManagedCpuUsage {
  const userMs = current.userMs - previous.userMs;
  const systemMs = current.systemMs - previous.systemMs;
  if (userMs < 0 || systemMs < 0) {
    throw new Error("process CPU counters decreased");
  }
  return { userMs, systemMs, totalMs: userMs + systemMs };
}

function withModel(usage: ModelUsage, model?: string): ManagedTokenUsage {
  return model === undefined ? { ...usage } : { model, ...usage };
}

function hasUsage(usage: ManagedMessageUsage | ManagedTurnUsage): boolean {
  return usage.tokens !== undefined || usage.cpu !== undefined ||
    usage.ram !== undefined;
}
