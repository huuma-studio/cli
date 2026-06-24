# Implementation Plan — `huuma skills update`

> Derived from `docs/CONTEXT.md` (glossary) and
> `docs/adr/0003-huuma-skills-update.md` (decisions). Read both first —
> this plan does not re-justify the choices, it sequences the build.

## Goal

Ship `huuma skills update [NAMES...] [--force]` that re-fetches each
tracked skill from the GitHub `ref` recorded in
`.agents/skills/.manifest.json` and updates the on-disk copy when upstream
has moved. Untracked skills are skipped. Locally edited tracked skills are
not overwritten without `--force`. Per-skill best-effort with a summary
line and exit code `1` on any failure/refusal.

## Conventions

- **Deno + TypeScript**, matches the existing codebase.
- **No new dependencies**: reuses `@std/cli` (parseArgs), `@std/tar`,
  `@std/front-matter`, `@std/yaml`, `@std/path`, `@std/assert` — all
  already in `deno.json` from the `add` feature.
- **No new leaf modules**: `update` is a thin layer over existing
  `src/skills/` modules (`manifest`, `path`, `extract`, `fetch`,
  `validate`, `fs_utils`). No modifications to any existing leaf module.
- **Tests**: in-memory tarballs via `@std/tar` `TarStream` (matching
  `bundle_test.ts`), no live network, no binary fixtures. The injected
  `fetch` seam drives all tests.
- **Output style**: inherits `add`'s conventions — `dim("…")` progress,
  `green("✓")` success, `red("✖")` failure, `yellow("⚠")` non-fatal
  warnings, plus a final `Summary:` line. CI/non-TTY-safe (no spinner,
  no interactivity).

## File map (new + modified)

```
cli/
├── README.md                       [modify] add `### Updating skills` subsection
├── src/
│   ├── skills/
│   │   ├── skills.ts               [modify] register `update` in the Registry
│   │   ├── update.ts               [new] update orchestrator + subcommand entry point
│   │   └── update_test.ts          [new] per-skill outcome matrix + mixed runs + summary
│   └── (no other files modified)
```

> **No new `testdata/`**: reuses `src/skills/testdata/valid-skill/` and
> `src/skills/testdata/manifest.fixture.json` for on-disk fixtures. Cases
> needing regressed/renamed upstream content use in-memory `@std/tar`
> tarballs built at test time, matching `bundle_test.ts`.

## Implementation order

The plan is sequenced so each step depends only on earlier ones. Tests
are written alongside the module (not deferred to the end) so each commit
is verifiable in isolation.

### Dependency graph

```
T1 (update.ts orchestrator + subcommand)
 │
 ├── T2 (update_test.ts)
 │
 ├── T3 (register in skills.ts)
 │
 └── T4 (README)
```

T1 is the spine. T2 depends on T1 (tests the orchestrator). T3 depends on
T1 (registers the subcommand). T4 is independent (documentation only).

### Parallelisable batches

- **Batch A**: T1 (orchestrator is the foundation; nothing else can start
  without it).
- **Batch B** (after T1): T2, T3, T4 in parallel — tests, registration,
  and README are disjoint write scopes.

### Module contract ground rules

- `update.ts` exports `updateSkills(opts: UpdateOptions): Promise<UpdateResult>`
  (the orchestrator) and a default export (the subcommand entry point with
  arg parsing). Mirrors `add.ts`'s `runAdd` + default-export pattern, but
  the orchestrator lives in the same file (there is no separate
  `install`-equivalent to factor out — `update` is its own orchestrator).
- `update.ts` imports only from existing leaf modules:
  - `manifest.ts`: `readManifest`, `writeManifest`, `contentHashOf`,
    `detectLocalEdits`, `Manifest`, `ManifestEntry`
  - `path.ts`: `codeloadUrl`, `formatSource`, `Source`
  - `extract.ts`: `extractSkill`
  - `fetch.ts`: `downloadTarball`
  - `validate.ts`: `validateSkill`, `readSkillName`, `ValidationError`
  - `fs_utils.ts`: `sweepStaleTemps`, `swapDirectory`, `randomSuffix`
  - `terminal.ts`: `dim`, `green`, `red`, `yellow`
  - `command.ts`: `isHelpFlag`
  - `@std/cli`: `parseArgs`
  - `@std/path`: `join`
- `update.ts` defines its own local `safeRemove(path)` for best-effort
  temp cleanup: `fs_utils.ts` does **not** export one (it is private to
  `install.ts`). Mirror `install.ts`'s 3-line `try { Deno.remove(path,
  { recursive: true }) } catch { /* swallow */ }`.
- No modifications to any existing `src/skills/*.ts` leaf module.
- `src/skills/skills.ts` is the only existing file modified (register
  `update` in the `Registry`).

### Step 1 — `src/skills/update.ts` (orchestrator + subcommand)

New file. Two exports:

**`updateSkills(opts: UpdateOptions): Promise<UpdateResult>`** — the
orchestrator. Flow:

1. Compute `skillsDir = join(cwd, ".agents", "skills")`.
2. `await sweepStaleTemps(skillsDir)` — one sweep at the start (ADR §
   "Stale-temp sweep once at the start").
3. `const manifest = await readManifest(skillsDir)`.
4. Determine the selected skill set:
   - If `names` is empty → all manifest entry keys, sorted.
   - If `names` is non-empty → those names, sorted. Names not in the
     manifest are per-skill `failed` outcomes (`✖ <name>: not tracked;
     nothing to update`).
5. **Empty-registry short-circuit** — if `names` is empty *and* the
   manifest has no entries, print `No tracked skills to update.` and
   return `{ outcomes: [], exitCode: 0 }` (no `Summary:` line). Per ADR
   §"Output shape and exit code". (When `names` is non-empty against an
   empty manifest, every name is a per-skill `not tracked` failure
   instead — exit `1`.)
6. For each selected name, in sorted order, call
   `updateOneSkill(trackedName, entry, ...)`. Collect per-skill outcomes
   into a result list.
7. After all skills processed, fold the M updated manifest entries into
   the in-memory manifest and call `writeManifest(skillsDir, updated)` —
   one write per run (ADR §"One manifest write per run"). If no skills
   updated, skip the write entirely (no-op-only run writes nothing).
8. Print the `Summary:` line.
9. Return `{ outcomes, exitCode }`.

**`updateOneSkill(trackedName, entry, ...)`: Promise<SkillOutcome>`** —
per-skill logic. `trackedName` is the manifest key — it is both the
registry key and the on-disk dir basename; `entry` is its
`ManifestEntry`. The upstream `SKILL.md`'s own `name` is read separately
as `upstreamName`, and the two are **never** conflated — keeping them
distinct is what makes rename detection work (the previous draft reused
one `name` variable for both, which made the rename check a tautology).
Returns one of: `updated`, `up-to-date`, `refused`, `failed` (with a
message). Flow:

1. **Missing-on-disk check** — `Deno.stat(join(skillsDir, trackedName))`.
   If the dir doesn't exist, return `failed` with: `"tracked in manifest
   but missing from disk; run 'huuma skills remove <trackedName>' to
   clean up, or 'huuma skills add --path=<source-url>' to reinstall."`
   No fetch.
2. **Locally-edited check** (only when not `--force`) —
   `detectLocalEdits(manifest, trackedName, skillsDir)`. If true, return
   `refused` with: `"skill has local edits; re-run with --force to
   discard them."` No fetch.
3. **Fetch + extract** —
   - `log(dim("… Checking <trackedName>"))`.
   - Fetch, labelling the failure explicitly: `try { tarball = await
     fetchImpl(codeloadUrl(entry.source)) } catch (e) { → failed "fetch
     failed (<e.message>)" }`. `downloadTarball` throws `FetchError`
     whose message already carries the status (e.g. `Ref 'main' not
     found in 'owner/repo' (HTTP 404)`); the `fetch failed (...)` prefix
     is added here, not inherited — the generic catch-all would not
     produce the `✖ <name>: fetch failed` line the ADR/output spec
     wants.
   - Stage into `.tmp-<rand>/staging/`, extract via `extractSkill({
     tarball, subpath: entry.source.subpath, destDir: staging })`. The
     recorded `subpath` **must** be threaded through — omitting it
     extracts the whole repo instead of the skill subtree.
   - `const upstreamName = await readSkillName(staging)`.
4. **Rename check** — if `upstreamName !== trackedName`: clean up
   staging, return `failed` with `"upstream renamed the skill to
   '<upstreamName>'; remove and re-add to track it under the new name."`
   No swap, no manifest change. This is the ADR §3 detection; it compares
   the re-read upstream name against `trackedName`, **not** against
   itself.
   - Otherwise rename staging to `.tmp-<rand>/<trackedName>/`, set
     `skillStageDir` to it and `target = join(skillsDir, trackedName)`.
     Naming the staging dir after `trackedName` (not `upstreamName`) is
     what keeps `validateSkill`'s name≡basename invariant in step 6
     meaningful and keeps the swap landing in the existing registry slot.
   - `const upstreamHash = await contentHashOf(skillStageDir)`.
5. **Already-current check** — if `upstreamHash === entry.contentHash`:
   - Under `--force` the step-2 locally-edited check was skipped, so
     compute the on-disk hash here (`contentHashOf(target)`). If it
     differs from `entry.contentHash` (hand-edited disk, upstream
     unmoved): print `yellow("⚠ overwriting local edits in
     <trackedName>")`, swap, update manifest entry, return `updated`.
   - Otherwise (no `--force`, or `--force` with nothing to discard):
     clean up staging, print `green("✓ <trackedName> is up to date
     (owner/repo@ref)")`, return `up-to-date`. No swap, no manifest
     change.
6. **Validate** — `const { warnings } = await
   validateSkill(skillStageDir)`.
   - If `ValidationError`: clean up staging, return `failed` with
     `"upstream validation failed (<message>)"`. No swap. The
     name≡basename invariant holds by construction here (the rename case
     already returned in step 4), so this fires only on a genuine
     upstream regression — dropped `SKILL.md`, broken name regex,
     oversized `description`.
   - Print optional-field warnings via `yellow(...)`.
7. **Locally-edited + --force overwrite warning** — reached only when
   upstream moved (step 5 returned otherwise). If `--force` and the
   on-disk content differs from `entry.contentHash` (local edits about to
   be discarded): print `yellow("⚠ overwriting local edits in
   <trackedName>")`. Without local edits this is a clean update and no
   warning is printed; without `--force` a locally-edited skill already
   returned `refused` in step 2.
8. **Swap** — `await swapDirectory({ tempDir: skillStageDir, target })`.
   Clean up the temp parent dir via a local `safeRemove` (see ground
   rules — `fs_utils.ts` does not export one).
9. **Record updated entry** — compute new `contentHash` of the swapped
   `target`, build a new `ManifestEntry` with the same `source` (ref
   unchanged), new `contentHash`, new `installedAt`. Return `updated`
   with the entry for the end-of-run manifest write.

**Error handling per skill**: any unexpected throw (fetch network error,
extract guard violation, rename failure) is caught, staging is cleaned
up, and the skill returns `failed` with the error message. Other skills
continue processing (per-skill best-effort, ADR §"Per-skill best-effort,
not atomic").

**Default export** — the subcommand entry point. Mirrors `add.ts`:

- Parse args via `parseArgs(args, { ... })`: positional `_` = names,
  `--force` boolean, `--help`/`-h` boolean.
- `--help`/`-h` → print `updateHelp()`, return `""`.
- Call `updateSkills({ names, force, cwd: Deno.cwd() })`.
- On any throw from `updateSkills` itself (not per-skill): print
  `red("✖ ...")` to stderr, `Deno.exitCode = 1`, return `""`.
- Set `Deno.exitCode` based on the result's `exitCode`.
- Return `""`.

**`updateHelp(): string`** — usage text per ADR §"Command surface".

**`UpdateOptions` interface**:

```ts
interface UpdateOptions {
  names: string[];
  force: boolean;
  cwd: string;
  fetch?: (url: string) => Promise<ReadableStream<Uint8Array>>;
  log?: (line: string) => void;
}
```

**`UpdateResult` interface**:

```ts
interface SkillOutcome {
  name: string;
  status: "updated" | "up-to-date" | "refused" | "failed";
  message: string;
  entry?: ManifestEntry; // only for "updated" — folded into manifest at end
  warnings: string[];
}

interface UpdateResult {
  outcomes: SkillOutcome[];
  exitCode: number; // 0 iff no refused/failed, 1 otherwise
}
```

### Step 2 — `src/skills/update_test.ts`

New file. Mirrors `install_test.ts` + `bundle_test.ts` style — in-memory
tarballs via `TarStream`, temp `cwd`, cleanup in `finally`.

Helper: `buildSkillTarball(dirPath, content)` — emits a
`repo-main/<dirPath>/SKILL.md` with the given content (and optionally
additional files) as an **uncompressed** `TarStream`, returned as a
`ReadableStream<Uint8Array>` (matching `bundle_test.ts`'s `buildTarball`:
the `fetch` seam returns already-decompressed bytes, i.e. what
`downloadTarball` yields *after* the gzip step — so the test tarball must
not be gzipped). `dirPath` is the recorded source subpath (e.g.
`skills/mcp-builder`) so the bytes match what `extractSkill` filters on;
the frontmatter `name` inside `content` is independent of `dirPath` — the
upstream-rename case (8) relies on the two differing. Reused across test
cases.

Helper: `writeManifestFixture(skillsDir, entries)` — writes a
`.manifest.json` with the given entries (name → { source, contentHash,
installedAt }). The already-current/up-to-date cases need
`contentHash` to equal `contentHashOf` of the matching on-disk skill (the
static `testdata/manifest.fixture.json` hash is a placeholder and will
never match real extracted content), so those tests compute the hash via
the imported `contentHashOf` rather than hard-coding a string.

Helper: `writeSkillDir(skillsDir, name, content)` — writes a skill
directory with `SKILL.md` (for setting up on-disk state in tests).

Test cases (ADR §"Testability", 14 cases):

1. **Already current** — manifest entry hash == re-fetched hash. Assert:
   no swap, manifest unchanged (mtime), `✓ up to date` in output, exit
   `0`.
2. **Updated** — re-fetched hash differs, validation passes. Assert:
   swap happened, manifest `contentHash` + `installedAt` bumped, `✓
   updated` in output, exit `0`.
3. **Locally edited, no `--force`** — on-disk hash ≠ manifest,
   upstream differs. Assert: no swap, `✖ refused` in output, exit `1`.
4. **Locally edited, `--force`** — same setup, `force: true`. Assert:
   swap, manifest re-synced, `⚠ overwriting` in output, exit `0`.
5. **Locally edited but already-current upstream** — on-disk ≠ manifest
   (edits), upstream == manifest (no movement). Without `--force`:
   `✖ refused`, exit `1`. With `--force`: `⚠ overwrites`, re-syncs
   hash, exit `0`.
6. **Fetch failure** — injected `fetch` throws. Assert: `✖ fetch
   failed` in output, other selected skills still processed, exit `1`.
7. **Upstream validation regression** — re-fetched `SKILL.md` has
   invalid `name`. Assert: `✖ upstream validation failed`, no swap,
   exit `1`.
8. **Upstream name changed** — manifest tracks `<name>`, but the
   re-fetched `SKILL.md` (still at the recorded subpath) declares
   `name: totally-different`. Assert: `✖ <name>: upstream renamed the
   skill to 'totally-different'`, no swap, on-disk dir + manifest entry
   untouched, exit `1`. (Guards the rename-detection fix: `upstreamName`
   is compared to `trackedName`, not to itself.)
9. **Missing on disk** — manifest has entry, dir doesn't exist. Assert:
   `✖ missing from disk`, no fetch, exit `1`.
10. **Untracked name on CLI** — `update nonexistent`, no manifest entry.
    Assert: `✖ not tracked`, exit `1`.
11. **Mixed run** — one updated, one up-to-date, one refused. Assert:
    summary counts correct, exit `1` (refusal), sorted-by-name order.
12. **No-op-only run** — all already-current. Assert: manifest file
    unchanged (no write), `Summary: updated 0 · up to date N`, exit
    `0`.
13. **`--force` with nothing to discard** — all already-current, no
    edits. Assert: behaves like no-`--force`, exit `0`.
14. **Empty registry** — manifest `skills: {}`, no names. Assert: `No
    tracked skills to update.`, exit `0`.

All tests use the `fetch` seam — no live network, no `Deno.serve`.

### Step 3 — Register `update` in `src/skills/skills.ts`

Modified file. Add `update` to the `Registry`:

```ts
import update from "./update.ts";

registry.add({
  names: ["update"],
  description: "Re-fetch tracked skills from their recorded GitHub ref",
  command: update,
});
```

The `skillsHelp()` output automatically includes `update` via
`registry.all()`. No changes to `skills_test.ts` needed for registration,
but a test asserting `update` appears in `skills --help` is a good smoke
test (add to `skills_test.ts` if desired, or rely on T2's coverage).

### Step 4 — README: `### Updating skills` subsection

Modified file. Add a `### Updating skills` subsection within the existing
`## Skills` section, after the `huuma skills add` documentation. Content:

- `huuma skills update [NAMES...] [--force]` usage.
- One-paragraph explanation: re-fetches each tracked skill from its
  recorded GitHub ref, updates the on-disk copy when upstream has moved.
- Zero names = all tracked skills; untracked skills are skipped.
- `--force` discards local edits.
- Per-skill outcomes: up to date, updated, refused (local edits), failed
  (fetch/validation/missing). Exit `1` on any failure/refusal.
- Example: `huuma skills update` / `huuma skills update mcp-builder
  --force`.

## Final validation

1. `deno task check` — type-check the whole tree including `update.ts`
   and modified `skills.ts`.
2. `deno task test` — full suite; `update_test.ts` runs offline;
   existing skills tests stay green.
3. Manual smoke (requires a project with at least one tracked skill):
   - `huuma skills update` → per-skill `… Checking` + `✓` lines +
     `Summary:`.
   - Edit a tracked skill's `SKILL.md`, re-run → `✖ refused`; re-run
     with `--force` → `⚠ overwriting` + `✓ updated`.
   - `huuma skills update nonexistent` → `✖ not tracked; nothing to
     update`, exit `1`.
   - `huuma skills update` on an empty registry → `No tracked skills to
     update.`, exit `0`.
4. `huuma skills --help` shows `update` in the sub-command list.
5. `huuma skills update --help` shows the usage text.

## Out of scope (per ADR 0003)

- `huuma skills list`, `remove`, `repair`/`sync`.
- Tag-ladder resolution (`--ref=<new-ref>`, `huuma skills upgrade`).
- `--dry-run` (deferred to a future `huuma skills status`/`outdated`).
- `--concurrency=<n>` (v2 concern).
- `--atomic` (v2 concern).
- Auto-migration of renamed upstream skills.
- `resolvedSha` manifest field + GitHub REST tip-SHA comparison.
- Private-repo auth, non-GitHub sources, `/`-containing refs — inherited
  from ADR 0001.
