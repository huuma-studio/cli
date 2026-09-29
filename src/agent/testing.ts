/** Test-only helpers shared by the agent module's `_test.ts` files. */
import type { BaseModel, ModelResult } from "@huuma/ai/agent";

/** Runs `fn` with terminal output suppressed so the REPL chrome
 * ("Thinking...", colors, error lines) stays out of the test report. */
export async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const { log, error } = console;
  const writeSync = Deno.stdout.writeSync.bind(Deno.stdout);
  console.log = () => {};
  console.error = () => {};
  Deno.stdout.writeSync = () => 0;
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
    Deno.stdout.writeSync = writeSync;
  }
}

/** Sets env vars (a `null` value clears one) for the duration of `fn`, then
 * restores the prior environment. Requires `--allow-env`. */
export async function withEnv(
  vars: Record<string, string | null>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const prior = new Map(
    Object.keys(vars).map((key) => [key, Deno.env.get(key)]),
  );
  for (const [key, value] of Object.entries(vars)) {
    if (value === null) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

/** A model whose `generate` never responds — like a provider that accepted
 * the connection but stalled — and only settles by rejecting with its
 * signal's reason. Records every signal it receives so tests can assert the
 * deadline reached the adapter. */
export class HangingModel implements BaseModel<string> {
  signals: (AbortSignal | undefined)[] = [];

  generate(args: unknown): Promise<ModelResult<string>> {
    const { signal } = args as { signal?: AbortSignal };
    this.signals.push(signal);
    return new Promise((_, reject) => {
      if (signal?.aborted) reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  }

  stream(): Promise<AsyncGenerator<ModelResult>> {
    return Promise.reject(new Error("Not implemented"));
  }
}

/** Tracks whether `promise` has settled, without letting a rejection go
 * unhandled while a test advances fake time. */
export function track<T>(
  promise: Promise<T>,
): { settled: () => boolean; result: Promise<T> } {
  let settled = false;
  const result = promise.finally(() => settled = true);
  result.catch(() => {});
  return { settled: () => settled, result };
}
