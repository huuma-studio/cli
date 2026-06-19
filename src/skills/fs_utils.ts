/**
 * Filesystem helpers for the install orchestrator.
 *
 * Extracted so they can be unit-tested in isolation without spinning up a
 * network mock. No dependencies on any other `skills/*` module.
 */
import { join } from "@std/path";

/** Removes `.tmp-*` and `.old-*` directories left over from a previously
 * crashed `add` run. Best-effort: all errors are swallowed. Does not touch
 * skill directories or the `.manifest.json` file. */
export async function sweepStaleTemps(skillsDir: string): Promise<void> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(skillsDir)) {
      if (
        entry.isDirectory &&
        (entry.name.startsWith(".tmp-") || entry.name.startsWith(".old-"))
      ) {
        names.push(entry.name);
      }
    }
  } catch {
    return; // missing dir or unreadable — nothing to sweep.
  }
  await Promise.all(names.map(async (name) => {
    try {
      await Deno.remove(join(skillsDir, name), { recursive: true });
    } catch {
      // Swallow — best-effort cleanup.
    }
  }));
}

/** Small random suffix (first 8 hex chars of a UUID) used by `swapDirectory`
 * and the orchestrator's temp dir name, so the naming scheme lives in one
 * place. */
export function randomSuffix(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

export interface SwapOptions {
  tempDir: string;
  target: string;
}

/** Atomic-ish stage-then-swap.
 *
 * 1. If `target` does not exist: `rename(tempDir, target)`. Done.
 * 2. If `target` exists: rename it to `target.old-<rand>/`, then rename
 *    `tempDir` to `target`. If the second rename fails, attempt to restore
 *    `target` from the `.old-<rand>/` dir, then rethrow.
 * 3. On success of step 2, recursively delete the `.old-<rand>/` dir. */
export async function swapDirectory(opts: SwapOptions): Promise<void> {
  const { tempDir, target } = opts;

  let targetExists = false;
  try {
    await Deno.stat(target);
    targetExists = true;
  } catch {
    targetExists = false;
  }

  if (!targetExists) {
    await Deno.rename(tempDir, target);
    return;
  }

  const oldDir = `${target}.old-${randomSuffix()}`;
  await Deno.rename(target, oldDir);
  try {
    await Deno.rename(tempDir, target);
  } catch (cause) {
    // Rollback: restore the old dir to target, then rethrow.
    try {
      await Deno.rename(oldDir, target);
    } catch {
      // Best-effort restore; original error is the one we report.
    }
    throw cause;
  }

  // Success — clean up the backed-up old dir.
  try {
    await Deno.remove(oldDir, { recursive: true });
  } catch {
    // Non-fatal: a stray .old- dir will be swept on the next run.
  }
}
