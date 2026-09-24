import type { ModelUsage } from "@huuma/ai/agent";

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
