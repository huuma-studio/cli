/** Test-only helpers shared by the agent module's `_test.ts` files. */

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
