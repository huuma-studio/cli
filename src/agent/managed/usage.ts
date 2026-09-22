/**
 * Per-message usage telemetry for managed turns (spec 106, ADR 0011).
 *
 * {@link UsageTracker} composes the optional `usage` payload the managed
 * runner attaches to `message.appended` and `turn.finished` callbacks:
 *
 * - **tokens** — the delta between the accumulated `@huuma/ai` usage snapshot
 *   passed with this message and the one passed with the previous emission.
 *   A snapshot identical to the previous emission means no model call
 *   happened in between (tool messages, later messages of a multi-message
 *   batch), so `tokens` is omitted. The per-attempt baseline resets to
 *   `undefined` on every re-invoked `agent.run` attempt (ADR 0010), so the
 *   first message of an attempt carries that attempt's whole usage so far.
 * - **cpu** — `/proc/self/stat` counters (`utime`+`cutime` for user,
 *   `stime`+`cstime` for system, at CLK_TCK = 100) sampled at each emission,
 *   reported as the delta since the previous emission (`turn.running` for
 *   the first). The counters are monotone, so the baseline simply continues
 *   across retry attempts. Omitted when `/proc` is unavailable (macOS dev).
 * - **ram** — gauges from `Deno.memoryUsage()` sampled at each emission:
 *   current `rssBytes`/`heapUsedBytes` plus `peakRssBytes`, the Turn-scoped
 *   maximum of the emission samples (not a continuous monitor).
 *
 * Telemetry is fail-safe at every layer: sampling happens only at emission
 * points (negligible overhead), and a sampling failure is logged with only the
 * affected section omitted — collection never blocks, delays, or corrupts
 * message delivery. All sources are injectable ({@link UsageDeps}) so tests
 * stay deterministic.
 */
import type { ModelUsage } from "@huuma/ai/agent";
import { sumModelUsage } from "@huuma/ai/agent";

/** Token usage attributable to one message: the delta between consecutive
 * accumulated snapshots, plus the model identifier used for the call (for
 * later cost computation). Absent fields mean "not reported", not zero. */
export interface UsageTokens {
  /** Model identifier of the call the tokens are attributable to. */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Total tokens of the attributable call(s) as reported or derived. */
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  thinkingTokens?: number;
}

/** CPU milliseconds consumed by the runner process (self + reaped children)
 * since the previous emission of this Turn. */
export interface UsageCpu {
  userMs: number;
  systemMs: number;
  totalMs: number;
}

/** RAM gauges sampled at emission. `peakRssBytes` is the Turn-scoped maximum
 * of the emission samples. */
export interface UsageRam {
  rssBytes: number;
  heapUsedBytes: number;
  peakRssBytes: number;
}

/** The optional `usage` payload of `message.appended` and the Turn summary of
 * `turn.finished`. Every section is optional; an all-sections-failure
 * composition collapses to `undefined` and the field is omitted entirely. */
export interface MessageUsage {
  tokens?: UsageTokens;
  cpu?: UsageCpu;
  ram?: UsageRam;
}

/** The `turn.finished` usage summary: Turn-total tokens (sum of every retry
 * attempt's final snapshot), cumulative CPU since `turn.running`, and final
 * RAM gauges with the Turn-scoped peak. */
export type TurnUsageSummary = MessageUsage;

/** Raw CPU counters from `/proc/self/stat` — user ticks (`utime`+`cutime`)
 * and system ticks (`stime`+`cstime`), covering reaped child processes (tool
 * commands are awaited and reaped before the tool message is emitted). */
export interface CpuCounters {
  userTicks: number;
  systemTicks: number;
}

/** Current RAM gauges from `Deno.memoryUsage()`. */
export interface RamGauges {
  rssBytes: number;
  heapUsedBytes: number;
}

/** Injectable sampling sources, mirroring `CallbackDeps`/`RetryDeps` so tests
 * stay deterministic. */
export interface UsageDeps {
  /** Reads the process CPU counters, or `undefined` when unavailable
   * (`/proc` does not exist on macOS). Never throws. */
  readCpu: () => CpuCounters | undefined;
  /** Reads the current RAM gauges. Production reads never throw. */
  readRam: () => RamGauges;
  /** Error sink for sanitized sampling diagnostics. */
  logError: (message: string) => void;
}

/** `/proc/self/stat` reports CPU time in clock ticks; Linux fixes CLK_TCK at
 * 100 (10 ms per tick) for the procfs ABI. */
const CLK_TCK = 100;
const MS_PER_TICK = 1000 / CLK_TCK;

/** The `ModelUsage` fields summed into token deltas. Mirrors
 * `@huuma/ai`'s usage keys (not exported from the public surface). */
const TOKEN_KEYS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "thinkingTokens",
] as const;

/** Production sampling sources: `/proc/self/stat` for CPU (sync read of a
 * tiny procfs file — no await keeps sampling off the delivery critical path),
 * `Deno.memoryUsage()` for RAM. */
export function productionUsageDeps(
  logError: (message: string) => void,
): UsageDeps {
  return {
    readCpu: readProcCpuCounters,
    readRam: () => {
      const memory = Deno.memoryUsage();
      return { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed };
    },
    logError,
  };
}

/** Reads `utime`/`stime`/`cutime`/`cstime` from `/proc/self/stat`. The
 * `comm` field can contain spaces and parentheses, so fields are indexed
 * after the final `)`. Returns `undefined` on any failure (missing `/proc`,
 * malformed content) — never throws. */
function readProcCpuCounters(): CpuCounters | undefined {
  try {
    const stat = Deno.readTextFileSync("/proc/self/stat");
    const close = stat.lastIndexOf(")");
    if (close === -1) return undefined;
    // Fields after `comm` start at state (field 3); utime is field 14.
    const fields = stat.slice(close + 2).split(" ");
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);
    const cutime = Number(fields[13]);
    const cstime = Number(fields[14]);
    if (
      !Number.isFinite(utime) || !Number.isFinite(stime) ||
      !Number.isFinite(cutime) || !Number.isFinite(cstime)
    ) {
      return undefined;
    }
    // Reaped children are folded into the matching mode: user = utime+cutime,
    // system = stime+cstime.
    return { userTicks: utime + cutime, systemTicks: stime + cstime };
  } catch {
    // /proc is unavailable (macOS dev) or unreadable — omit the cpu section.
    return undefined;
  }
}

/** Turn-scoped usage composition. Construct one per Turn, call
 * {@link UsageTracker.start} after `turn.running` is acknowledged (the CPU
 * baseline), {@link UsageTracker.resetAttempt} before every `agent.run`
 * invocation, {@link UsageTracker.messageUsage} per emitted message, and
 * {@link UsageTracker.turnSummary} once for `turn.finished`. No method ever
 * throws. */
export class UsageTracker {
  readonly #deps: UsageDeps;
  readonly #model: string | undefined;
  /** CPU baseline at `turn.running` — the Turn summary's delta origin. */
  #cpuStart: CpuCounters | undefined;
  /** CPU sample at the previous emission — the per-message delta origin. */
  #cpuPrev: CpuCounters | undefined;
  /** Snapshot passed with the previous emission of the current attempt. */
  #prevSnapshot: ModelUsage | undefined;
  /** Latest snapshot of the current attempt (its final snapshot once the
   * attempt ends). */
  #attemptLast: ModelUsage | undefined;
  /** Sum of the final snapshots of every completed attempt. */
  #turnTokens: ModelUsage | undefined;
  /** Turn-scoped maximum of sampled RSS. */
  #peakRssBytes: number | undefined;

  constructor(deps: UsageDeps, model?: string) {
    this.#deps = deps;
    this.#model = model;
  }

  /** Captures the CPU baselines. Called once after `turn.running` was
   * delivered and acknowledged. */
  start(): void {
    const sample = this.#sampleCpu("start");
    this.#cpuStart = sample;
    this.#cpuPrev = sample;
  }

  /** Folds the current attempt's final snapshot into the Turn total and
   * resets the per-attempt token baseline, so the first message of the next
   * attempt carries only that attempt's usage (ADR 0010). CPU baselines are
   * deliberately NOT reset — the counters are monotone, so the deltas simply
   * continue across attempts. */
  resetAttempt(): void {
    this.#turnTokens = sumModelUsage(this.#turnTokens, this.#attemptLast);
    this.#attemptLast = undefined;
    this.#prevSnapshot = undefined;
  }

  /** Composes the `usage` payload for one emission, or `undefined` when no
   * section could be determined (the field is then omitted entirely). */
  messageUsage(snapshot: ModelUsage | undefined): MessageUsage | undefined {
    const tokens = this.#tokenDelta(snapshot);
    const cpu = this.#cpuDelta("message");
    const ram = this.#ramGauges();
    if (tokens === undefined && cpu === undefined && ram === undefined) {
      return undefined;
    }
    return {
      ...(tokens !== undefined && { tokens }),
      ...(cpu !== undefined && { cpu }),
      ...(ram !== undefined && { ram }),
    };
  }

  /** Composes the Turn summary for `turn.finished`: Turn-total tokens (every
   * attempt's final snapshot summed), cumulative CPU since `turn.running`,
   * and final gauges with the Turn-scoped peak. `turn.failed` never calls
   * this. Idempotent — no state is mutated. */
  turnSummary(): TurnUsageSummary | undefined {
    let tokens: UsageTokens | undefined;
    try {
      const total = sumModelUsage(this.#turnTokens, this.#attemptLast);
      if (total !== undefined) {
        tokens = {
          ...(this.#model !== undefined && { model: this.#model }),
          ...total,
        };
      }
    } catch (error) {
      this.#report("tokens", error);
    }
    const cpu = this.#cpuTurnDelta();
    const ram = this.#ramGauges();
    if (tokens === undefined && cpu === undefined && ram === undefined) {
      return undefined;
    }
    return {
      ...(tokens !== undefined && { tokens }),
      ...(cpu !== undefined && { cpu }),
      ...(ram !== undefined && { ram }),
    };
  }

  /** Token delta for one emission. The snapshot is compared to the previous
   * emission's snapshot by value: an unchanged accumulated snapshot means no
   * model call happened in between (tool messages, later messages of a
   * batch), so `tokens` is omitted rather than reported as a zero delta. */
  #tokenDelta(snapshot: ModelUsage | undefined): UsageTokens | undefined {
    try {
      if (snapshot === undefined) return undefined;
      this.#attemptLast = snapshot;
      const previous = this.#prevSnapshot;
      const unchanged = previous !== undefined &&
        JSON.stringify(snapshot) === JSON.stringify(previous);
      this.#prevSnapshot = snapshot;
      if (unchanged) return undefined;
      const delta: UsageTokens = {};
      let reported = false;
      for (const key of TOKEN_KEYS) {
        const current = snapshot[key];
        if (current === undefined) continue;
        reported = true;
        delta[key] = Math.max(0, current - (previous?.[key] ?? 0));
      }
      // A first snapshot whose fields are all absent ("not reported") has
      // nothing attributable to this message.
      return reported
        ? { ...(this.#model !== undefined && { model: this.#model }), ...delta }
        : undefined;
    } catch (error) {
      this.#report("tokens", error);
      return undefined;
    }
  }

  /** CPU delta since the previous emission, updating the rolling baseline. */
  #cpuDelta(stage: string): UsageCpu | undefined {
    try {
      const sample = this.#sampleCpu(stage);
      if (sample === undefined || this.#cpuPrev === undefined) return undefined;
      const cpu = cpuDeltaBetween(sample, this.#cpuPrev);
      this.#cpuPrev = sample;
      return cpu;
    } catch (error) {
      this.#report("cpu", error);
      return undefined;
    }
  }

  /** Cumulative CPU since `turn.running` for the Turn summary. */
  #cpuTurnDelta(): UsageCpu | undefined {
    try {
      const sample = this.#sampleCpu("turn_summary");
      if (sample === undefined || this.#cpuStart === undefined) {
        return undefined;
      }
      return cpuDeltaBetween(sample, this.#cpuStart);
    } catch (error) {
      this.#report("cpu", error);
      return undefined;
    }
  }

  /** RAM gauges for an emission, advancing the Turn-scoped RSS peak. */
  #ramGauges(): UsageRam | undefined {
    try {
      const gauges = this.#deps.readRam();
      this.#peakRssBytes = Math.max(this.#peakRssBytes ?? 0, gauges.rssBytes);
      return {
        rssBytes: gauges.rssBytes,
        heapUsedBytes: gauges.heapUsedBytes,
        peakRssBytes: this.#peakRssBytes,
      };
    } catch (error) {
      this.#report("ram", error);
      return undefined;
    }
  }

  #sampleCpu(stage: string): CpuCounters | undefined {
    try {
      return this.#deps.readCpu();
    } catch (error) {
      this.#report(`cpu.${stage}`, error);
      return undefined;
    }
  }

  #report(section: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#deps.logError(
      `[managed:usage.${section}] ${message}`,
    );
  }
}

/** Converts the tick delta between two counter samples to milliseconds.
 * Monotone counters should never go backwards; a backwards reading means the
 * sample is not trustworthy, so `undefined` (omit the section) is returned
 * rather than a fabricated number. */
function cpuDeltaBetween(
  current: CpuCounters,
  baseline: CpuCounters,
): UsageCpu | undefined {
  const userTicks = current.userTicks - baseline.userTicks;
  const systemTicks = current.systemTicks - baseline.systemTicks;
  if (userTicks < 0 || systemTicks < 0) return undefined;
  const userMs = Math.round(userTicks * MS_PER_TICK);
  const systemMs = Math.round(systemTicks * MS_PER_TICK);
  return { userMs, systemMs, totalMs: userMs + systemMs };
}