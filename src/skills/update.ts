/**
 * `huuma skills update` subcommand + orchestrator.
 *
 * Re-fetches each tracked skill from the GitHub `ref` recorded in
 * `.agents/skills/.manifest.json` and updates the on-disk copy when upstream
 * has moved. Untracked skills are skipped. Locally edited tracked skills are
 * not overwritten without `--force`. Per-skill best-effort with a summary line
 * and exit code `1` on any failure/refusal.
 *
 * Thin layer over the existing leaf modules (manifest, path, extract, fetch,
 * validate, fs_utils) — no new leaf modules, no modifications to them. Mirrors
 * `add.ts`'s `runAdd` + default-export pattern, but the orchestrator lives in
 * this same file (there is no separate `install`-equivalent to factor out).
 *
 * See docs/adr/0003-huuma-skills-update.md for the load-bearing decisions.
 */
import { join } from "@std/path";
import { parseArgs } from "@std/cli/parse-args";
import { dim, green, red, yellow } from "../terminal.ts";
import { isHelpFlag } from "../command.ts";
import { codeloadUrl, formatSource } from "./path.ts";
import { extractSkill } from "./extract.ts";
import { downloadTarball } from "./fetch.ts";
import { readSkillName, validateSkill, ValidationError } from "./validate.ts";
import {
  contentHashOf,
  detectLocalEdits,
  type Manifest,
  type ManifestEntry,
  readManifest,
  writeManifest,
} from "./manifest.ts";
import { randomSuffix, swapDirectory, sweepStaleTemps } from "./fs_utils.ts";

export interface UpdateOptions {
  names: string[];
  force: boolean;
  cwd: string;
  /** Test seam: injected codeload fetch. Defaults to the real
   * `downloadTarball`. Tests pass an in-memory tarball stream. */
  fetch?: (url: string) => Promise<ReadableStream<Uint8Array>>;
  /** Output sink for progress/success/warning/summary lines. Defaults to
   * `console.log`. Tests capture this instead of patching the console. */
  log?: (line: string) => void;
}

export interface SkillOutcome {
  name: string;
  status: "updated" | "up-to-date" | "refused" | "failed";
  message: string;
  /** Only for `"updated"` — folded into the manifest at the end of the run. */
  entry?: ManifestEntry;
  warnings: string[];
}

export interface UpdateResult {
  outcomes: SkillOutcome[];
  /** `0` iff no skill was refused or failed; `1` otherwise. */
  exitCode: number;
}

/** Re-fetches each tracked skill from its recorded GitHub ref and updates the
 * on-disk copy when upstream has moved. Processes skills sequentially in
 * sorted-by-name order, best-effort: a failure/refusal on one skill does not
 * abort the others. The manifest is rewritten once at the end with the entries
 * of every successfully swapped skill folded in; a no-op-only run writes
 * nothing. */
export async function updateSkills(opts: UpdateOptions): Promise<UpdateResult> {
  const { names, force, cwd } = opts;
  const fetchImpl = opts.fetch ?? ((url: string) => downloadTarball(url));
  const log = opts.log ?? console.log;

  const skillsDir = join(cwd, ".agents", "skills");

  // One stale-temp sweep at the start — reuses fs_utils' helper verbatim, so
  // stale dirs from a crashed `add` and a crashed `update` are handled alike.
  await sweepStaleTemps(skillsDir);

  const manifest = await readManifest(skillsDir);
  const manifestKeys = Object.keys(manifest.skills);

  // Determine the selected skill set.
  // - No names: every tracked skill, sorted.
  // - Names given: those names, sorted (de-duplicated). Names not in the
  //   manifest become per-skill `failed` outcomes below — no fetch.
  const selected = (names.length === 0 ? manifestKeys : [...new Set(names)])
    .sort();

  // Empty-registry short-circuit: no names and no entries → nothing to do.
  // (Names against an empty manifest fall through: every name is a
  // `not tracked` failure, exit 1.)
  if (names.length === 0 && manifestKeys.length === 0) {
    log("No tracked skills to update.");
    return { outcomes: [], exitCode: 0 };
  }

  const outcomes: SkillOutcome[] = [];
  for (const trackedName of selected) {
    const entry = manifest.skills[trackedName];
    let outcome: SkillOutcome;
    if (!entry) {
      outcome = {
        name: trackedName,
        status: "failed",
        message: "not tracked; nothing to update",
        warnings: [],
      };
    } else {
      outcome = await updateOneSkill(
        trackedName,
        entry,
        skillsDir,
        manifest,
        force,
        fetchImpl,
        log,
      );
    }
    outcomes.push(outcome);
    // Print the ✖ line for refused/failed outcomes here so the streaming order
    // matches processing order (success/warning lines are printed inside
    // `updateOneSkill` as they happen).
    if (outcome.status === "refused" || outcome.status === "failed") {
      log(red(`✖ ${outcome.name}: ${outcome.message}`));
    }
  }

  // One manifest write per run: fold every successfully swapped skill's new
  // entry into the in-memory manifest and write once. No-op-only and all-fail
  // runs write nothing.
  const updatedOutcomes = outcomes.filter(
    (o): o is SkillOutcome & { entry: ManifestEntry } =>
      o.status === "updated" && o.entry !== undefined,
  );
  if (updatedOutcomes.length > 0) {
    const newSkills: Record<string, ManifestEntry> = { ...manifest.skills };
    for (const o of updatedOutcomes) {
      newSkills[o.name] = o.entry;
    }
    await writeManifest(skillsDir, { skills: newSkills });
  }

  const updated = outcomes.filter((o) => o.status === "updated").length;
  const upToDate = outcomes.filter((o) => o.status === "up-to-date").length;
  const refused = outcomes.filter((o) => o.status === "refused").length;
  const failed = outcomes.filter((o) => o.status === "failed").length;
  log(
    `Summary: updated ${updated} · up to date ${upToDate} · refused ${refused} · failed ${failed}`,
  );

  const exitCode = (refused > 0 || failed > 0) ? 1 : 0;
  return { outcomes, exitCode };
}

/** Per-skill update logic. `trackedName` is the manifest key — both the
 * registry key and the on-disk dir basename. The upstream `SKILL.md`'s own
 * `name` is read separately as `upstreamName`; the two are kept distinct so
 * rename detection compares `upstreamName` to `trackedName` (not to itself). */
async function updateOneSkill(
  trackedName: string,
  entry: ManifestEntry,
  skillsDir: string,
  manifest: Manifest,
  force: boolean,
  fetchImpl: (url: string) => Promise<ReadableStream<Uint8Array>>,
  log: (line: string) => void,
): Promise<SkillOutcome> {
  const target = join(skillsDir, trackedName);
  const warnings: string[] = [];

  // 1. Missing-on-disk check — no fetch.
  try {
    await Deno.stat(target);
  } catch {
    return {
      name: trackedName,
      status: "failed",
      message:
        `tracked in manifest but missing from disk; run 'huuma skills remove ${trackedName}' to clean up, or 'huuma skills add --path=<source-url>' to reinstall.`,
      warnings,
    };
  }

  // 2. Locally-edited check — skipped under --force.
  if (!force) {
    if (await detectLocalEdits(manifest, trackedName, skillsDir)) {
      return {
        name: trackedName,
        status: "refused",
        message: "skill has local edits; re-run with --force to discard them.",
        warnings,
      };
    }
  }

  // 3. Fetch + extract.
  let tarball: ReadableStream<Uint8Array>;
  try {
    log(dim(`… Checking ${trackedName}`));
    tarball = await fetchImpl(codeloadUrl(entry.source));
  } catch (e) {
    return {
      name: trackedName,
      status: "failed",
      message: `fetch failed (${(e as Error)?.message ?? String(e)})`,
      warnings,
    };
  }

  const tempRoot = join(skillsDir, `.tmp-${randomSuffix()}`);
  const staging = join(tempRoot, "staging");
  try {
    await Deno.mkdir(staging, { recursive: true });

    // Extract into staging, threading the recorded `subpath` — omitting it
    // would extract the whole repo instead of the skill subtree.
    await extractSkill({
      tarball,
      subpath: entry.source.subpath,
      destDir: staging,
    });

    // Read the upstream name. A `ValidationError` here (missing SKILL.md, bad
    // name regex) is an upstream regression — frame it as such.
    let upstreamName: string;
    try {
      upstreamName = await readSkillName(staging);
    } catch (e) {
      if (e instanceof ValidationError) {
        return {
          name: trackedName,
          status: "failed",
          message: `upstream validation failed (${e.message})`,
          warnings,
        };
      }
      throw e;
    }

    // 4. Rename check — `upstreamName` vs `trackedName`, never conflated.
    if (upstreamName !== trackedName) {
      return {
        name: trackedName,
        status: "failed",
        message:
          `upstream renamed the skill to '${upstreamName}'; remove and re-add to track it under the new name.`,
        warnings,
      };
    }
    // Name the staging dir after `trackedName` (not `upstreamName` — they are
    // equal here, but using `trackedName` is what keeps the swap landing in the
    // existing registry slot and keeps validateSkill's name≡basename invariant
    // meaningful).
    const skillStageDir = join(tempRoot, trackedName);
    await Deno.rename(staging, skillStageDir);

    const upstreamHash = await contentHashOf(skillStageDir);

    // 5. Already-current check.
    if (upstreamHash === entry.contentHash) {
      if (force) {
        // The locally-edited guard was skipped under --force, so compute the
        // on-disk hash here. If disk differs from the manifest (hand-edited
        // disk, upstream unmoved), --force means "discard the edits" → swap.
        const diskHash = await contentHashOf(target);
        if (diskHash !== entry.contentHash) {
          log(yellow(`⚠ overwriting local edits in ${trackedName}`));
          await swapDirectory({ tempDir: skillStageDir, target });
          return {
            name: trackedName,
            status: "updated",
            message: `updated (${formatSource(entry.source)})`,
            entry: {
              source: entry.source,
              contentHash: await contentHashOf(target),
              installedAt: new Date().toISOString(),
            },
            warnings,
          };
        }
      }
      // No --force, or --force with nothing to discard → up to date.
      log(
        green(`✓ ${trackedName} is up to date (${formatSource(entry.source)})`),
      );
      return {
        name: trackedName,
        status: "up-to-date",
        message: `up to date (${formatSource(entry.source)})`,
        warnings,
      };
    }

    // 6. Validate the freshly-extracted upstream content before swap.
    try {
      const { warnings: validateWarnings } = await validateSkill(skillStageDir);
      for (const w of validateWarnings) {
        log(yellow(`  ⚠ ${w}`));
      }
      warnings.push(...validateWarnings);
    } catch (e) {
      if (e instanceof ValidationError) {
        return {
          name: trackedName,
          status: "failed",
          message: `upstream validation failed (${e.message})`,
          warnings,
        };
      }
      throw e;
    }

    // 7. --force overwrite warning — reached only when upstream moved (step 5
    //    returned otherwise). Without --force a locally-edited skill already
    //    returned `refused` in step 2.
    if (force) {
      const diskHash = await contentHashOf(target);
      if (diskHash !== entry.contentHash) {
        log(yellow(`⚠ overwriting local edits in ${trackedName}`));
      }
    }

    // 8. Swap into the existing `<trackedName>/` slot.
    await swapDirectory({ tempDir: skillStageDir, target });

    // 9. Record updated entry — same `source` (ref unchanged), new hash + time.
    return {
      name: trackedName,
      status: "updated",
      message: `updated (${formatSource(entry.source)})`,
      entry: {
        source: entry.source,
        contentHash: await contentHashOf(target),
        installedAt: new Date().toISOString(),
      },
      warnings,
    };
  } catch (cause) {
    // Any unexpected throw (extract guard violation, rename failure, …):
    // clean up staging and surface a per-skill `failed`. Other skills
    // continue — per-skill best-effort, not atomic.
    return {
      name: trackedName,
      status: "failed",
      message: (cause as Error)?.message ?? String(cause),
      warnings,
    };
  } finally {
    await safeRemove(tempRoot);
  }
}

/** Best-effort recursive remove. `fs_utils.ts` does not export one (it is
 * private to `install.ts`); mirror its 3-line swallow-and-move-on shape. */
async function safeRemove(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch {
    // Swallow — best-effort cleanup.
  }
}

/** Default export: run `huuma skills update`. Parses args, dispatches to
 * `updateSkills`, and sets `Deno.exitCode` from the result. Per-skill failures
 * are surfaced via the orchestrator's output (not thrown); only an unexpected
 * throw from `updateSkills` itself lands in the catch. */
export default async (args: string[] = []): Promise<string> => {
  const err = console.error;

  // Validate flags up front: positional NAMES are allowed, unknown flags are
  // rejected. We can't use parseArgs' `unknown` callback for this — in
  // @std/cli 1.0.30 it fires for positionals too, which would refuse NAMES.
  // parseArgs otherwise swallows an unknown `--flag` by consuming the next
  // token as its value, so pre-scanning the raw args is the robust check.
  const KNOWN_FLAGS = new Set(["--force", "--help", "-h"]);
  for (const a of args) {
    if (a === "--") break; // rest are positionals
    if (a === "-" || !a.startsWith("-")) continue; // positional NAME
    const base = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (!KNOWN_FLAGS.has(base)) {
      err(red(`✖ Unknown option: ${a}`));
      err(updateHelp());
      Deno.exitCode = 1;
      return "";
    }
  }

  const parsed = parseArgs(args, {
    boolean: ["force", "help"],
    alias: { help: "h" },
    default: { force: false, help: false },
  });

  if (parsed.help || args.some(isHelpFlag)) {
    return updateHelp();
  }

  const names = parsed._.map(String);

  try {
    const result = await updateSkills({
      names,
      force: parsed.force,
      cwd: Deno.cwd(),
    });
    Deno.exitCode = result.exitCode;
  } catch (cause) {
    err(red(`✖ ${(cause as Error)?.message ?? String(cause)}`));
    Deno.exitCode = 1;
  }
  return "";
};

/** Usage text for `huuma skills update --help`, mirroring `addHelp`. */
export function updateHelp(): string {
  return `Re-fetch tracked skills from their recorded GitHub ref.

USAGE
  huuma skills update [NAMES...] [--force]

Re-fetches each tracked skill from the GitHub ref recorded in
.agents/skills/.manifest.json and updates the on-disk copy when upstream has
moved. With no names, updates every tracked skill. Untracked skills are
skipped. Locally edited tracked skills are not overwritten unless --force is
passed.

FLAGS
  --force     Overwrite skills whose on-disk content has been hand-edited
  -h, --help  Show this help

EXAMPLES
  huuma skills update
  huuma skills update mcp-builder --force`;
}
