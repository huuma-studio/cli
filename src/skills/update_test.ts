import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { TarStream } from "@std/tar/tar-stream";
import { updateSkills } from "./update.ts";
import {
  contentHashOf,
  type Manifest,
  type ManifestEntry,
  readManifest,
} from "./manifest.ts";
import type { Source } from "./path.ts";

const encoder = new TextEncoder();

/** Builds a plain (uncompressed) tarball stream. The fetch seam returns
 * decompressed bytes, matching what `downloadTarball` yields after gzip — so
 * the test tarball must not be gzipped. Mirrors `bundle_test.ts`. */
function buildTarball(
  files: { path: string; content: string }[],
): ReadableStream<Uint8Array> {
  const input = files.map((f) => {
    const bytes = encoder.encode(f.content);
    return {
      type: "file" as const,
      path: f.path,
      size: bytes.byteLength,
      readable: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
    };
  });
  return ReadableStream.from(input).pipeThrough(new TarStream());
}

/** SKILL.md text with the given frontmatter name (+ optional description/body). */
function skillMd(
  name: string,
  description = `${name} skill`,
  body = `# ${name}`,
): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

/** Builds a single-skill tarball whose top dir is `repo-main/` and the skill
 * lives under `<subpath>/`. `subpath` (the recorded source subpath, e.g.
 * `skills/mcp-builder`) is independent of the frontmatter `name` — the
 * upstream-rename case relies on the two differing. */
function buildSkillTarball(opts: {
  subpath: string[];
  name: string;
  description?: string;
  body?: string;
  /** Extra files inside the skill dir, paths relative to the skill dir root. */
  extra?: { path: string; content: string }[];
}): ReadableStream<Uint8Array> {
  const dir = opts.subpath.join("/");
  const files: { path: string; content: string }[] = [{
    path: `repo-main/${dir}/SKILL.md`,
    content: skillMd(opts.name, opts.description, opts.body),
  }];
  for (const e of opts.extra ?? []) {
    files.push({ path: `repo-main/${dir}/${e.path}`, content: e.content });
  }
  return buildTarball(files);
}

/** Canonical source for a tracked skill: anthropics/skills@main, subpath
 * `skills/<name>`. */
function trackedSource(name: string): Source {
  return {
    owner: "anthropics",
    repo: "skills",
    ref: "main",
    subpath: ["skills", name],
  };
}

/** Writes a `.manifest.json` with the given entries (name → entry). */
async function writeManifestFixture(
  skillsDir: string,
  entries: Record<string, ManifestEntry>,
): Promise<void> {
  await Deno.mkdir(skillsDir, { recursive: true });
  const manifest: Manifest = { skills: entries };
  await Deno.writeTextFile(
    join(skillsDir, ".manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

/** Writes a skill directory at `<skillsDir>/<name>/SKILL.md` (+ optional extra
 * files, paths relative to the skill dir). Used to set up on-disk state. */
async function writeSkillDir(
  skillsDir: string,
  name: string,
  content: string,
  extra: { path: string; content: string }[] = [],
): Promise<void> {
  const dir = join(skillsDir, name);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, "SKILL.md"), content);
  for (const e of extra) {
    const p = join(dir, e.path);
    await Deno.mkdir(dirname(p), { recursive: true });
    await Deno.writeTextFile(p, e.content);
  }
}

/** Entry with the hash of the on-disk skill at `<skillsDir>/<name>/`. Call
 * after `writeSkillDir` so the hash reflects the disk content. */
async function entryFor(
  skillsDir: string,
  name: string,
  source: Source,
  installedAt = "2024-01-01T00:00:00.000Z",
): Promise<ManifestEntry> {
  return {
    source,
    contentHash: await contentHashOf(join(skillsDir, name)),
    installedAt,
  };
}

/** Lists entry names under `skillsDir` for stray-dir assertions. */
async function dirNames(skillsDir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const e of Deno.readDir(skillsDir)) names.push(e.name);
  return names;
}

/** Asserts no `.tmp-*` / `.old-*` dirs are left behind under `skillsDir`. */
function assertNoTempDirs(names: string[]): void {
  assertEquals(
    names.filter((n) => n.startsWith(".tmp-") || n.startsWith(".old-")).length,
    0,
    "no stray .tmp-/.old- dirs should remain",
  );
}

/** Captures log lines into an array; `out` joins them for order checks. */
function captureLog(): { log: (l: string) => void; out: () => string } {
  const lines: string[] = [];
  return {
    log: (l: string) => void lines.push(l),
    out: () => lines.join("\n"),
  };
}

/** Builds an ordered fetch seam that hands out one tarball per call, in
 * sorted-by-name processing order. The codeload URL carries no subpath, so we
 * can't dispatch on it; sequential sorted processing makes a queue reliable. */
function orderedSeam(tarballs: ReadableStream<Uint8Array>[]): (
  url: string,
) => Promise<ReadableStream<Uint8Array>> {
  let i = 0;
  return () => Promise.resolve(tarballs[i++] ?? tarballs[tarballs.length - 1]);
}

// ---------------------------------------------------------------------------
// 1. Already current
// ---------------------------------------------------------------------------

Deno.test("update: already current — no swap, manifest unchanged, exit 0", async () => {
  const cwd = await Deno.makeTempDir();
  const cap = captureLog();
  try {
    const skillsDir = join(cwd, ".agents", "skills");
    const name = "mcp-builder";
    const content = skillMd(name);
    await writeSkillDir(skillsDir, name, content);
    await writeManifestFixture(skillsDir, {
      [name]: await entryFor(skillsDir, name, trackedSource(name)),
    });
    const before = await Deno.readTextFile(join(skillsDir, ".manifest.json"));

    const result = await updateSkills({
      names: [],
      force: false,
      cwd,
      fetch: () =>
        Promise.resolve(buildSkillTarball({ subpath: ["skills", name], name })),
      log: cap.log,
    });

    assertEquals(result.exitCode, 0);
    const oc = result.outcomes[0];
    assertEquals(oc.name, name);
    assertEquals(oc.status, "up-to-date");

    // No swap, no manifest write: file byte-for-byte unchanged.
    const after = await Deno.readTextFile(join(skillsDir, ".manifest.json"));
    assertEquals(after, before);
    assertStringIncludes(cap.out(), "is up to date");
    assertNoTempDirs(await dirNames(skillsDir));
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Updated
// ---------------------------------------------------------------------------

Deno.test("update: upstream moved — swap, manifest re-hashed, exit 0", async () => {
  const cwd = await Deno.makeTempDir();
  const cap = captureLog();
  try {
    const skillsDir = join(cwd, ".agents", "skills");
    const name = "mcp-builder";
    await writeSkillDir(skillsDir, name, skillMd(name, undefined, "# v1"));
    const beforeHash = await contentHashOf(join(skillsDir, name));
    await writeManifestFixture(skillsDir, {
      [name]: {
        source: trackedSource(name),
        contentHash: beforeHash,
        installedAt: "2024-01-01T00:00:00.000Z",
      },
    });

    const result = await updateSkills({
      names: [],
      force: false,
      cwd,
      fetch: () =>
        Promise.resolve(
          buildSkillTarball({
            subpath: ["skills", name],
            name,
            body: "# v2 — moved",
          }),
        ),
      log: cap.log,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.outcomes[0].status, "updated");

    // On-disk now holds v2.
    const disk = await Deno.readTextFile(join(skillsDir, name, "SKILL.md"));
    assertStringIncludes(disk, "v2 — moved");

    // Manifest re-hashed to match the new on-disk content, installedAt bumped.
    const manifest = await readManifest(skillsDir);
    const entry = manifest.skills[name];
    assertEquals(entry.contentHash, await contentHashOf(join(skillsDir, name)));
    assert(entry.installedAt !== "2024-01-01T00:00:00.000Z");
    assertStringIncludes(cap.out(), "updated");
    assertNoTempDirs(await dirNames(skillsDir));
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Locally edited, no --force — refused, exit 1
// ---------------------------------------------------------------------------

Deno.test("update: local edits without --force — refused, no swap, exit 1", async () => {
  const cwd = await Deno.makeTempDir();
  const cap = captureLog();
  try {
    const skillsDir = join(cwd, ".agents", "skills");
    const name = "mcp-builder";
    await writeSkillDir(skillsDir, name, skillMd(name, undefined, "# v1"));
    await writeManifestFixture(skillsDir, {
      [name]: await entryFor(skillsDir, name, trackedSource(name)),
    });
    // Hand-edit the on-disk skill so disk != manifest hash.
    await writeSkillDir(skillsDir, name, skillMd(name, "edited", "# edited"));
    const diskBefore = await Deno.readTextFile(
      join(skillsDir, name, "SKILL.md"),
    );

    const result = await updateSkills({
      names: [],
      force: false,
      cwd,
      fetch: () =>
        Promise.resolve(
          buildSkillTarball({
            subpath: ["skills", name],
            name,
            body: "# v2 — moved",
          }),
        ),
      log: cap.log,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(result.outcomes[0].status, "refused");

    // No swap — disk untouched.
    const diskAfter = await Deno.readTextFile(
      join(skillsDir, name, "SKILL.md"),
    );
    assertEquals(diskAfter, diskBefore);
    assertStringIncludes(cap.out(), "refused");
    assertStringIncludes(cap.out(), "--force");
    assertNoTempDirs(await dirNames(skillsDir));
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Locally edited, --force — overwritten, exit 0
// ---------------------------------------------------------------------------

Deno.test("update: local edits with --force — overwritten, manifest re-synced, exit 0", async () => {
  const cwd = await Deno.makeTempDir();
  const cap = captureLog();
  try {
    const skillsDir = join(cwd, ".agents", "skills");
    const name = "mcp-builder";
    await writeSkillDir(skillsDir, name, skillMd(name, undefined, "# v1"));
    await writeManifestFixture(skillsDir, {
      [name]: await entryFor(skillsDir, name, trackedSource(name)),
    });
    await writeSkillDir(skillsDir, name, skillMd(name, "edited", "# edited"));

    const result = await updateSkills({
      names: [],
      force: true,
      cwd,
      fetch: () =>
        Promise.resolve(
          buildSkillTarball({
            subpath: ["skills", name],
            name,
            body: "# v2 — moved",
          }),
        ),
      log: cap.log,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.outcomes[0].status, "updated");

    // On-disk now holds v2 (edits discarded).
    const disk = await Deno.readTextFile(join(skillsDir, name, "SKILL.md"));
    assertStringIncludes(disk, "v2 — moved");

    const manifest = await readManifest(skillsDir);
    assertEquals(
      manifest.skills[name].contentHash,
      await contentHashOf(join(skillsDir, name)),
    );
    assertStringIncludes(cap.out(), "overwriting local edits");
    assertNoTempDirs(await dirNames(skillsDir));
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Locally edited but already-current upstream (with / without --force)
// ---------------------------------------------------------------------------

Deno.test("update: local edits, upstream unmoved — refused without --force, exit 1", async () => {
  const cwd = await Deno.makeTempDir();
  const cap = captureLog();
  try {
    const skillsDir = join(cwd, ".agents", "skills");
    const name = "mcp-builder";
    // canonical matches the re-fetched tarball's default content so upstream is
    // genuinely unmoved (the refuse happens before fetch, but keeping the
    // setup honest documents the intended scenario).
    const canonical = skillMd(name);
    await writeSkillDir(skillsDir, name, canonical);
    await writeManifestFixture(skillsDir, {
      [name]: await entryFor(skillsDir, name, trackedSource(name)),
    });
    // Hand-edit disk; upstream will re-fetch to the canonical (unchanged) hash.
    await writeSkillDir(skillsDir, name, skillMd(name, "edited", "# edited"));

    const result = await updateSkills({
      names: [],
      force: false,
      cwd,
      fetch: () =>
        Promise.resolve(buildSkillTarball({ subpath: ["skills", name], name })),
      log: cap.log,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(result.outcomes[0].status, "refused");
    // Disk still holds the edit (no swap).
    const disk = await Deno.readTextFile(join(skillsDir, name, "SKILL.md"));
    assertStringIncludes(disk, "edited");
    assertNoTempDirs(await dirNames(skillsDir));
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("update: local edits, upstream unmoved, --force — overwrites and re-syncs hash, exit 0", async () => {
  const cwd = await Deno.makeTempDir();
  const cap = captureLog();
  try {
    const skillsDir = join(cwd, ".agents", "skills");
    const name = "mcp-builder";
    // canonical matches the re-fetched tarball's default content so the
    // already-current branch fires under --force.
    const canonical = skillMd(name);
    await writeSkillDir(skillsDir, name, canonical);
    const canonicalHash = await contentHashOf(join(skillsDir, name));
    await writeManifestFixture(skillsDir, {
      [name]: {
        source: trackedSource(name),
        contentHash: canonicalHash,
        installedAt: "2024-01-01T00:00:00.000Z",
      },
    });
    await writeSkillDir(skillsDir, name, skillMd(name, "edited", "# edited"));

    const result = await updateSkills({
      names: [],
      force: true,
      cwd,
      fetch: () =>
        Promise.resolve(buildSkillTarball({ subpath: ["skills", name], name })),
      log: cap.log,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.outcomes[0].status, "updated");

    // On-disk restored to canonical content.
    const disk = await Deno.readTextFile(join(skillsDir, name, "SKILL.md"));
    assertEquals(disk, canonical);

    // Manifest contentHash re-synced to the canonical hash (unchanged value),
    // installedAt bumped.
    const manifest = await readManifest(skillsDir);
    assertEquals(manifest.skills[name].contentHash, canonicalHash);
    assert(
      manifest.skills[name].installedAt !== "2024-01-01T00:00:00.000Z",
    );
    assertStringIncludes(cap.out(), "overwriting local edits");
    assertNoTempDirs(await dirNames(skillsDir));
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 6. Fetch failure
// ---------------------------------------------------------------------------

Deno.test("update: fetch failure — failed, exit 1", async () => {
  const cwd = await Deno.makeTempDir();
  const cap = captureLog();
  try {
    const skillsDir = join(cwd, ".agents", "skills");
    const name = "mcp-builder";
    await writeSkillDir(skillsDir, name, skillMd(name));
    await writeManifestFixture(skillsDir, {
      [name]: await entryFor(skillsDir, name, trackedSource(name)),
    });

    const result = await updateSkills({
      names: [],
      force: false,
      cwd,
      fetch: () => Promise.reject(new Error("Ref 'main' not found (HTTP 404)")),
      log: cap.log,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(result.outcomes[0].status, "failed");
    assertStringIncludes(cap.out(), "fetch failed");
    assertStringIncludes(cap.out(), "HTTP 404");
    // On-disk skill untouched.
    const disk = await Deno.readTextFile(join(skillsDir, name, "SKILL.md"));
    assertStringIncludes(disk, "mcp-builder");
    assertNoTempDirs(await dirNames(skillsDir));
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 7. Upstream validation regression
// ---------------------------------------------------------------------------

Deno.test("update: upstream validation regression — failed, no swap, exit 1", async () => {
  const cwd = await Deno.makeTempDir();
  const cap = captureLog();
  try {
    const skillsDir = join(cwd, ".agents", "skills");
    const name = "mcp-builder";
    const canonical = skillMd(name);
    await writeSkillDir(skillsDir, name, canonical);
    await writeManifestFixture(skillsDir, {
      [name]: await entryFor(skillsDir, name, trackedSource(name)),
    });

    const result = await updateSkills({
      names: [],
      force: false,
      cwd,
      // Re-fetched SKILL.md declares an invalid name (underscore fails the
      // regex). readSkillName throws ValidationError → framed as upstream
      // validation failure.
      fetch: () =>
        Promise.resolve(
          buildSkillTarball({
            subpath: ["skills", name],
            name: "Bad_Name",
            description: "regressed",
          }),
        ),
      log: cap.log,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(result.outcomes[0].status, "failed");
    assertStringIncludes(cap.out(), "upstream validation failed");
    // No swap — on-disk canonical content intact.
    const disk = await Deno.readTextFile(join(skillsDir, name, "SKILL.md"));
    assertEquals(disk, canonical);
    assertNoTempDirs(await dirNames(skillsDir));
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 8. Upstream name changed (rename detection)
// ---------------------------------------------------------------------------

Deno.test("update: upstream renamed the skill — failed, no swap, manifest untouched, exit 1", async () => {
  const cwd = await Deno.makeTempDir();
  const cap = captureLog();
  try {
    const skillsDir = join(cwd, ".agents", "skills");
    const trackedName = "mcp-builder";
    const canonical = skillMd(trackedName);
    await writeSkillDir(skillsDir, trackedName, canonical);
    await writeManifestFixture(skillsDir, {
      [trackedName]: await entryFor(
        skillsDir,
        trackedName,
        trackedSource(trackedName),
      ),
    });
    const manifestBefore = await readManifest(skillsDir);

    // Re-fetched SKILL.md is still at the recorded subpath (skills/mcp-builder)
    // but declares name: totally-different.
    const result = await updateSkills({
      names: [],
      force: false,
      cwd,
      fetch: () =>
        Promise.resolve(
          buildSkillTarball({
            subpath: ["skills", trackedName],
            name: "totally-different",
            description: "renamed upstream",
          }),
        ),
      log: cap.log,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(result.outcomes[0].status, "failed");
    assertStringIncludes(
      cap.out(),
      "upstream renamed the skill to 'totally-different'",
    );

    // On-disk dir + manifest entry untouched.
    const disk = await Deno.readTextFile(
      join(skillsDir, trackedName, "SKILL.md"),
    );
    assertEquals(disk, canonical);
    assertEquals(await readManifest(skillsDir), manifestBefore);
    assertNoTempDirs(await dirNames(skillsDir));
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 9. Missing on disk
// ---------------------------------------------------------------------------

Deno.test("update: tracked but missing on disk — failed, no fetch, exit 1", async () => {
  const cwd = await Deno.makeTempDir();
  const cap = captureLog();
  try {
    const skillsDir = join(cwd, ".agents", "skills");
    const name = "mcp-builder";
    // Manifest has an entry, but the skill dir is never written.
    await writeManifestFixture(skillsDir, {
      [name]: {
        source: trackedSource(name),
        // Hash is a placeholder; missing-on-disk is detected before any fetch.
        contentHash: "sha256-placeholder",
        installedAt: "2024-01-01T00:00:00.000Z",
      },
    });
    let fetchCalled = false;

    const result = await updateSkills({
      names: [],
      force: false,
      cwd,
      fetch: () => {
        fetchCalled = true;
        return Promise.reject(new Error("should not be called"));
      },
      log: cap.log,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(result.outcomes[0].status, "failed");
    assertStringIncludes(cap.out(), "missing from disk");
    assertEquals(fetchCalled, false);
    assertNoTempDirs(await dirNames(skillsDir));
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 10. Untracked name on CLI
// ---------------------------------------------------------------------------

Deno.test("update: untracked name on CLI — failed, exit 1", async () => {
  const cwd = await Deno.makeTempDir();
  const cap = captureLog();
  try {
    const skillsDir = join(cwd, ".agents", "skills");
    // Empty manifest (no entries); the name is untracked.
    await writeManifestFixture(skillsDir, {});

    const result = await updateSkills({
      names: ["nonexistent"],
      force: false,
      cwd,
      fetch: () => Promise.reject(new Error("should not be called")),
      log: cap.log,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(result.outcomes[0].status, "failed");
    assertEquals(result.outcomes[0].name, "nonexistent");
    assertStringIncludes(cap.out(), "not tracked");
    assertNoTempDirs(await dirNames(skillsDir));
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 11. Mixed run — one updated, one up-to-date, one refused; sorted order
// ---------------------------------------------------------------------------

Deno.test("update: mixed run — summary counts correct, sorted order, exit 1", async () => {
  const cwd = await Deno.makeTempDir();
  const cap = captureLog();
  try {
    const skillsDir = join(cwd, ".agents", "skills");

    await writeSkillDir(
      skillsDir,
      "alpha",
      skillMd("alpha", undefined, "# v1"),
    );
    await writeSkillDir(skillsDir, "beta", skillMd("beta"));
    await writeSkillDir(
      skillsDir,
      "gamma",
      skillMd("gamma", undefined, "# v1"),
    );

    await writeManifestFixture(skillsDir, {
      alpha: await entryFor(skillsDir, "alpha", trackedSource("alpha")),
      beta: await entryFor(skillsDir, "beta", trackedSource("beta")),
      gamma: await entryFor(skillsDir, "gamma", trackedSource("gamma")),
    });
    // Hand-edit gamma so disk != manifest hash → refused (no --force).
    await writeSkillDir(
      skillsDir,
      "gamma",
      skillMd("gamma", "edited", "# edited"),
    );

    // Sorted processing order: alpha, beta, gamma.
    const tarballs: ReadableStream<Uint8Array>[] = [
      buildSkillTarball({
        subpath: ["skills", "alpha"],
        name: "alpha",
        body: "# v2",
      }),
      buildSkillTarball({ subpath: ["skills", "beta"], name: "beta" }),
      buildSkillTarball({
        subpath: ["skills", "gamma"],
        name: "gamma",
        body: "# v2",
      }),
    ];

    const result = await updateSkills({
      names: [],
      force: false,
      cwd,
      fetch: orderedSeam(tarballs),
      log: cap.log,
    });

    assertEquals(result.exitCode, 1); // gamma refused
    assertEquals(result.outcomes.length, 3);
    assertEquals(result.outcomes.map((o) => o.name), [
      "alpha",
      "beta",
      "gamma",
    ]);
    assertEquals(result.outcomes.map((o) => o.status), [
      "updated",
      "up-to-date",
      "refused",
    ]);

    assertStringIncludes(
      cap.out(),
      "Summary: updated 1 · up to date 1 · refused 1 · failed 0",
    );
    // Sorted-by-name order in the output stream.
    const alphaIdx = cap.out().indexOf("alpha");
    const betaIdx = cap.out().indexOf("beta");
    const gammaIdx = cap.out().indexOf("gamma");
    assert(alphaIdx < betaIdx, "alpha before beta");
    assert(betaIdx < gammaIdx, "beta before gamma");
    assertNoTempDirs(await dirNames(skillsDir));
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 12. No-op-only run — manifest unchanged, exit 0
// ---------------------------------------------------------------------------

Deno.test("update: no-op-only run — manifest file unchanged, exit 0", async () => {
  const cwd = await Deno.makeTempDir();
  const cap = captureLog();
  try {
    const skillsDir = join(cwd, ".agents", "skills");
    const names = ["alpha", "beta"];
    const entries: Record<string, ManifestEntry> = {};
    for (const n of names) {
      await writeSkillDir(skillsDir, n, skillMd(n));
      entries[n] = await entryFor(skillsDir, n, trackedSource(n));
    }
    await writeManifestFixture(skillsDir, entries);
    const before = await Deno.readTextFile(join(skillsDir, ".manifest.json"));

    const tarballs = names.map((n) =>
      buildSkillTarball({ subpath: ["skills", n], name: n })
    );
    const result = await updateSkills({
      names: [],
      force: false,
      cwd,
      fetch: orderedSeam(tarballs),
      log: cap.log,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.outcomes.map((o) => o.status), [
      "up-to-date",
      "up-to-date",
    ]);
    // No manifest write — file byte-for-byte unchanged.
    const after = await Deno.readTextFile(join(skillsDir, ".manifest.json"));
    assertEquals(after, before);
    assertStringIncludes(
      cap.out(),
      "Summary: updated 0 · up to date 2 · refused 0 · failed 0",
    );
    assertNoTempDirs(await dirNames(skillsDir));
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 13. --force with nothing to discard — behaves like no --force, exit 0
// ---------------------------------------------------------------------------

Deno.test("update: --force with nothing to discard — all up to date, exit 0", async () => {
  const cwd = await Deno.makeTempDir();
  const cap = captureLog();
  try {
    const skillsDir = join(cwd, ".agents", "skills");
    const names = ["alpha", "beta"];
    const entries: Record<string, ManifestEntry> = {};
    for (const n of names) {
      await writeSkillDir(skillsDir, n, skillMd(n));
      entries[n] = await entryFor(skillsDir, n, trackedSource(n));
    }
    await writeManifestFixture(skillsDir, entries);
    const before = await readManifest(skillsDir);

    const tarballs = names.map((n) =>
      buildSkillTarball({ subpath: ["skills", n], name: n })
    );
    const result = await updateSkills({
      names: [],
      force: true,
      cwd,
      fetch: orderedSeam(tarballs),
      log: cap.log,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.outcomes.map((o) => o.status), [
      "up-to-date",
      "up-to-date",
    ]);
    // No overwrite warning printed (nothing to discard), manifest unchanged.
    assertEquals(await readManifest(skillsDir), before);
    assert(!cap.out().includes("overwriting"), "no overwrite warning expected");
    assertNoTempDirs(await dirNames(skillsDir));
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 14. Empty registry — exit 0
// ---------------------------------------------------------------------------

Deno.test("update: empty registry, no names — No tracked skills, exit 0", async () => {
  const cwd = await Deno.makeTempDir();
  const cap = captureLog();
  try {
    const skillsDir = join(cwd, ".agents", "skills");
    await writeManifestFixture(skillsDir, {});

    const result = await updateSkills({
      names: [],
      force: false,
      cwd,
      fetch: () => Promise.reject(new Error("should not be called")),
      log: cap.log,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.outcomes.length, 0);
    assertStringIncludes(cap.out(), "No tracked skills to update.");
    // No summary line for the empty-registry short-circuit.
    assert(
      !cap.out().includes("Summary:"),
      "no summary line on empty registry",
    );
    assertNoTempDirs(await dirNames(skillsDir));
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});
