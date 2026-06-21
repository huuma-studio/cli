/**
 * Skill bundle orchestrator — installs a set of skills from a single GitHub
 * source in one atomic operation.
 *
 * Composes the existing skills leaf modules (path/validate/manifest/extract/
 * fetch/fs_utils); no leaf module imports this. The website project type is
 * the sole caller for now (see docs/adr/0002-skill-bundle-for-project-
 * scaffolding.md).
 *
 * Atomicity is all-or-nothing up to the swap phase: every candidate is
 * validated before any member is moved into `.agents/skills/`. Mid-swap
 * failures trigger best-effort rollback of already-swapped members, matching
 * the single-skill orchestrator's stance.
 *
 * Each member is recorded as a standalone `ManifestEntry` whose
 * `source.subpath` is `["skills", <memberName>]`, so a future
 * `huuma skills update` can re-fetch members individually without knowing
 * they came from a bundle.
 *
 * No collision / `--force` gate: the bundle assumes a fresh scaffold where
 * `.agents/skills/` does not pre-exist (see the ADR §"Collision policy — not
 * applicable in v1"). `swapDirectory` will silently overwrite a same-named dir
 * from a different source; reuse outside scaffolding requires adding a
 * collision matrix first.
 *
 * Exit-code ownership belongs to the caller, matching `installSkill`: this
 * module throws on failure and never touches `Deno.exitCode`.
 */
import { join } from "@std/path";
import { codeloadUrl, formatSource, type ParsedPath } from "./path.ts";
import { extractSkill } from "./extract.ts";
import { downloadTarball } from "./fetch.ts";
import { validateSkill } from "./validate.ts";
import {
  contentHashOf,
  type Manifest,
  type ManifestEntry,
  readManifest,
  writeManifest,
} from "./manifest.ts";
import { randomSuffix, swapDirectory, sweepStaleTemps } from "./fs_utils.ts";
import { dim, yellow } from "../terminal.ts";

export interface BundleOptions {
  /** Parsed GitHub source. `subpath` must point at the bundle root (e.g.
   * `["skills"]` for the website bundle). Each discovered member is recorded
   * with `source.subpath = [...parsed.subpath, <memberName>]`. */
  parsed: ParsedPath;
  /** Project root (relative or absolute). The install root is
   * `<cwd>/.agents/skills/`. */
  cwd: string;
  /** Test seam: injected fetch, same shape as `installSkill`'s. Defaults to
   * the real `downloadTarball`. */
  fetch?: (url: string) => Promise<ReadableStream<Uint8Array>>;
  /** Progress/success sink (default `console.log`). */
  log?: (line: string) => void;
}

export interface BundleMember {
  name: string;
  target: string;
  warnings: string[];
}

export interface BundleResult {
  /** Installed members. Empty if the source had no valid members or if the
   * bundle aborted (in which case the orchestrator throws before returning). */
  members: BundleMember[];
}

export class BundleValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BundleValidationError";
  }
}

/** Installs every valid skill found under `<parsed.subpath>/` of a single
 * GitHub source in one atomic operation. Downloads the tarball once, extracts
 * to a staging dir, validates every candidate, swaps all validated members
 * into `.agents/skills/`, and writes the manifest once with all entries.
 *
 * Throws `BundleValidationError` if any candidate fails validation (no member
 * is installed on this path). Rethrows extract/swap errors after best-effort
 * cleanup. Returns `{ members: [] }` when the source has no valid members. */
export async function installBundle(
  opts: BundleOptions,
): Promise<BundleResult> {
  const { parsed, cwd } = opts;
  const fetchImpl = opts.fetch ?? ((url: string) => downloadTarball(url));
  const log = opts.log ?? console.log;

  log(dim(`… Resolving ${formatSource(parsed)}`));

  const skillsDir = join(cwd, ".agents", "skills");
  await Deno.mkdir(skillsDir, { recursive: true });

  // Sweep stale .tmp-*/.old-* dirs from any previously crashed run.
  await sweepStaleTemps(skillsDir);

  // Download the codeload tarball (decompressed gzip stream) — one network call
  // for the whole bundle.
  const tarball = await fetchImpl(codeloadUrl(parsed));

  // Stage the bundle under a temp parent. extractSkill with the bundle subpath
  // strips the tarball's top dir and the subpath prefix, leaving one subdir per
  // candidate member directly under `staging/`.
  const tempRoot = join(skillsDir, `.tmp-${randomSuffix()}`);
  const staging = join(tempRoot, "staging");
  await Deno.mkdir(staging, { recursive: true });

  const subpathLabel = parsed.subpath.length > 0
    ? parsed.subpath.join("/")
    : "<repo root>";

  let members: BundleMember[] = [];
  try {
    log(dim(`… Extracting ${subpathLabel}`));
    await extractSkill({ tarball, subpath: parsed.subpath, destDir: staging });

    // Discover candidate members: every immediate subdir of `staging/` that
    // contains a `SKILL.md`. Non-skill entries (README-only dirs, dotfiles,
    // files at the staging root) are silently skipped.
    log(dim("… Discovering skill bundle members"));
    const candidateNames = await discoverCandidates(staging);

    // Validation phase — every candidate is validated (sorted, deterministic
    // order) before any member is swapped into `.agents/skills/`. A single
    // validation failure aborts the whole bundle: clean up staging and throw.
    const validated: { name: string; warnings: string[]; sourceDir: string }[] =
      [];
    for (const name of candidateNames) {
      const sourceDir = join(staging, name);
      try {
        const { name: validatedName, warnings } = await validateSkill(
          sourceDir,
        );
        // validateSkill enforces name === basename(dir), so validatedName === name.
        validated.push({ name: validatedName, warnings, sourceDir });
      } catch (cause) {
        const message = (cause as Error)?.message ?? String(cause);
        throw new BundleValidationError(
          `Bundle member '${name}' failed validation: ${message}`,
          { cause },
        );
      }
    }

    // Swap phase — move every validated member from staging into
    // `.agents/skills/<name>/`. Not strictly atomic across N renames: on a
    // mid-bundle failure, attempt best-effort rollback of already-swapped
    // members, then rethrow. A failed rollback is left for sweepStaleTemps.
    const swapped: { name: string; target: string; sourceDir: string }[] = [];
    for (const v of validated) {
      const target = join(skillsDir, v.name);
      log(dim(`… Installing .agents/skills/${v.name}/`));
      try {
        await swapDirectory({ tempDir: v.sourceDir, target });
        swapped.push({ name: v.name, target, sourceDir: v.sourceDir });
      } catch (cause) {
        for (const s of swapped) {
          try {
            await Deno.rename(s.target, s.sourceDir);
          } catch {
            log(
              yellow(
                `⚠ Could not roll back '${s.name}'; leaving for sweepStaleTemps.`,
              ),
            );
          }
        }
        throw cause;
      }
    }

    members = validated.map((v) => ({
      name: v.name,
      target: join(skillsDir, v.name),
      warnings: v.warnings,
    }));

    // Manifest write — single read, single write, one shared `installedAt`
    // timestamp so the registry reflects one atomic install. Each member is a
    // standalone entry with `source.subpath = [...parsed.subpath, name]`, making
    // it indistinguishable from a `huuma skills add` entry.
    if (validated.length > 0) {
      const manifest = await readManifest(skillsDir);
      const installedAt = new Date().toISOString();
      const updated: Manifest = { skills: { ...manifest.skills } };
      for (const v of validated) {
        const target = join(skillsDir, v.name);
        const hash = await contentHashOf(target);
        const entry: ManifestEntry = {
          source: {
            owner: parsed.owner,
            repo: parsed.repo,
            ref: parsed.ref,
            subpath: [...parsed.subpath, v.name],
          },
          contentHash: hash,
          installedAt,
        };
        updated.skills[v.name] = entry;
      }
      await writeManifest(skillsDir, updated);
    }
  } finally {
    // Always remove the temp parent (staging holds leftover non-member entries
    // on success, and the partial extraction on failure). Best-effort.
    await safeRemove(tempRoot);
  }

  return { members };
}

/** Walks `staging/` for immediate subdirectories containing a `SKILL.md`.
 * Returns the member names in sorted order for deterministic validation and
 * swap sequencing. Non-skill entries (no `SKILL.md`) are silently skipped —
 * but only on a clean `NotFound`; other `Deno.stat` failures (e.g.
 * `PermissionDenied`) are rethrown so a valid member is never silently dropped. */
async function discoverCandidates(staging: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(staging)) {
    if (!entry.isDirectory) continue;
    try {
      await Deno.stat(join(staging, entry.name, "SKILL.md"));
      names.push(entry.name);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
      // No SKILL.md — not a bundle member, skip.
    }
  }
  names.sort();
  return names;
}

async function safeRemove(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch {
    // Swallow — best-effort cleanup.
  }
}
