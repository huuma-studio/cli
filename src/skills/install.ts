/**
 * Install orchestrator — the join point wiring path/validate/manifest/extract/
 * fetch/fs_utils. No arg parsing here; takes a `ParsedPath` and a `--force`
 * boolean.
 *
 * See docs/adr/0001-huuma-skills-add.md §"Install target and atomicity" and
 * §"Collision policy". No module imports this except `add.ts`.
 */
import { join } from "@std/path";
import { codeloadUrl, formatSource, type ParsedPath } from "./path.ts";
import { extractSkill } from "./extract.ts";
import { downloadTarball } from "./fetch.ts";
import { readSkillName, validateSkill, ValidationError } from "./validate.ts";
import {
  contentHashOf,
  detectLocalEdits,
  findCollision,
  type Manifest,
  type ManifestEntry,
  readManifest,
  writeManifest,
} from "./manifest.ts";
import { randomSuffix, swapDirectory, sweepStaleTemps } from "./fs_utils.ts";
import { dim } from "../terminal.ts";

export class CollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollisionError";
  }
}

export class LocalEditsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalEditsError";
  }
}

export interface InstallOptions {
  parsed: ParsedPath;
  force: boolean;
  cwd: string;
  /** Test seam: inject an alternative for the network step. Defaults to the
   * real `downloadTarball`. Tests pass an in-memory version to avoid live
   * network. */
  fetch?: (url: string) => Promise<ReadableStream<Uint8Array>>;
  /** Output sink for `dim(...)` progress lines. Defaults to `console.log`.
   * Tests can capture this instead of patching the console. */
  log?: (line: string) => void;
}

export interface InstallResult {
  name: string;
  target: string;
  warnings: string[];
}

/** Installs a skill from a parsed GitHub path. Downloads, extracts to a temp
 * dir, validates, runs the collision decision matrix, swaps into place, and
 * updates the manifest. Returns `{ name, target, warnings }`. */
export async function installSkill(
  opts: InstallOptions,
): Promise<InstallResult> {
  const { parsed, force, cwd } = opts;
  const fetchImpl = opts.fetch ?? ((url: string) => downloadTarball(url));
  const log = opts.log ?? console.log;

  log(dim(`… Resolving ${formatSource(parsed)}`));

  const skillsDir = join(cwd, ".agents", "skills");
  await Deno.mkdir(skillsDir, { recursive: true });

  // Sweep stale .tmp-*/.old-* dirs from any previously crashed run.
  await sweepStaleTemps(skillsDir);

  // Download the codeload tarball (decompressed gzip stream).
  const tarball = await fetchImpl(codeloadUrl(parsed));

  // Stage into a temp parent dir. The skill name is unknown until SKILL.md has
  // been read, so we extract into a `staging/` subdir first, then rename it to
  // `<name>/` once the frontmatter name is known — this keeps `validateSkill`'s
  // name-≡-dir-basename invariant meaningful.
  const tempRoot = join(skillsDir, `.tmp-${randomSuffix()}`);
  const staging = join(tempRoot, "staging");
  await Deno.mkdir(staging, { recursive: true });

  const subpathLabel = parsed.subpath.length > 0
    ? parsed.subpath.join("/")
    : "<repo root>";
  log(dim(`… Extracting ${subpathLabel}`));

  try {
    await extractSkill({ tarball, subpath: parsed.subpath, destDir: staging });

    // Lightly read the name so we can name the staging dir before full
    // validation (which also checks name === basename(dir)).
    const name = await readSkillName(staging);
    const skillStageDir = join(tempRoot, name);
    await Deno.rename(staging, skillStageDir);

    log(dim("… Validating SKILL.md"));
    const { name: validatedName, warnings } = await validateSkill(
      skillStageDir,
    );

    const target = join(skillsDir, validatedName);

    // Collision matrix.
    const manifest = await readManifest(skillsDir);
    const collision = findCollision(manifest, validatedName, parsed);

    if (collision !== "none") {
      const edited = await detectLocalEdits(manifest, validatedName, skillsDir);
      if (collision === "different-source") {
        if (!force) {
          const existingSource = manifest.skills[validatedName].source;
          throw new CollisionError(
            `Skill '${validatedName}' is already installed from ${
              formatSource(existingSource)
            }. Re-run with --force to overwrite it with ${
              formatSource(parsed)
            }.`,
          );
        }
      } else { // same-source
        if (edited && !force) {
          throw new LocalEditsError(
            `Skill '${validatedName}' has local edits. Re-run with --force to discard them.`,
          );
        }
      }
    }

    log(dim(`… Installing to .agents/skills/${validatedName}/`));

    await swapDirectory({ tempDir: skillStageDir, target });

    // The temp parent is now empty (staging was renamed into place); clean it
    // up so no stray .tmp- dir is left behind on success.
    await safeRemove(tempRoot);

    // Record in the manifest. Re-read in case a concurrent install changed it,
    // but v1 is single-invocation so the in-memory copy is fine.
    const updated = await updateEntry(manifest, validatedName, parsed, target);
    await writeManifest(skillsDir, updated);

    return { name: validatedName, target, warnings };
  } catch (cause) {
    // Clean up the temp dir on any failure before the swap, leaving the
    // existing install untouched.
    await safeRemove(tempRoot);
    throw cause as Error;
  }
}

async function updateEntry(
  manifest: Manifest,
  name: string,
  parsed: ParsedPath,
  target: string,
): Promise<Manifest> {
  const hash = await contentHashOf(target);
  const entry: ManifestEntry = {
    source: {
      owner: parsed.owner,
      repo: parsed.repo,
      ref: parsed.ref,
      subpath: parsed.subpath,
    },
    contentHash: hash,
    installedAt: new Date().toISOString(),
  };
  return {
    skills: {
      ...manifest.skills,
      [name]: entry,
    },
  };
}

async function safeRemove(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch {
    // Swallow — best-effort cleanup.
  }
}

// Re-export for `add.ts` so it can catch typed errors without importing the
// leaf modules directly.
export { ValidationError };
