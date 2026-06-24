# `huuma skills update` — design decisions

Status: accepted

`huuma skills update` re-fetches each tracked skill from the GitHub ref
recorded in `.agents/skills/.manifest.json` and brings the on-disk copy to
the latest version of that ref. It is the second registry-mutation command
(after `huuma skills add`) and the first one that operates over many skills
at once. Glossary terms (`Skill`, `Skill source`, `Skill registry`,
`Tracked skill`, `Untracked skill`, `Locally edited skill`, `Skills update`)
live in `docs/CONTEXT.md`; this ADR records only the load-bearing decisions.

It is a thin layer over ADR 0001 (`huuma skills add`) and ADR 0002 (skill
bundle for project scaffolding). It reuses the path grammar, the codeload
tarball fetch, the tarball safety guards, `validateSkill`, the manifest
shape, and the output conventions from 0001; and it relies on 0002's
"each bundle member is a standalone manifest entry" decision so that
`update` needs no bundle-awareness — every tracked skill is the same kind
of entry, whether it arrived via `add` or via the website bundle.

## Load-bearing decisions

The four decisions below are facets of one question: _what does `update`
do when the registry, the on-disk skill, and upstream disagree?_ They are
recorded together because they are mutually reinforcing — per-skill
best-effort is why a missing-disk entry can be a soft failure rather than
a hard abort; `--force`'s overwrite semantics are why a locally-edited
skill is a refused-with-escape rather than a silent skip.

### 1. Per-skill best-effort, not atomic

`update` processes each tracked skill independently. A failure on one
skill (fetch error, upstream validation regression, refused local edits,
missing on disk, untracked name passed on the CLI) prints a `✖` line,
sets `Deno.exitCode = 1`, and does **not** abort the other selected
skills. The manifest is rewritten once at the end of the run with the
entries of every successfully swapped skill folded in.

Rejected alternative — atomic, all-or-nothing, mirroring ADR 0002's
bundle install. Rejected because `update` runs against an _existing_
registry, not a fresh project. Holding N−1 skills hostage to one deleted
upstream repo is actively worse than a partial update: the user cannot
get the other N−1 updates without manually removing the broken entry.
The bundle went atomic because it installs into an empty
`.agents/skills/` where partial installs are confusing; `update` does
not share that context. An `--atomic` flag could be added later if a
real user asks for it; going atomic-first would require an unwind path
and is harder to relax the other direction.

Exit code: `0` iff every selected skill ended in a success state
(updated or already current); `1` if any selected skill failed or was
refused. Refusal-on-local-edits counts as failure for exit-code
purposes because it is action the user must take (`--force`); a CI job
that goes green while the registry is stuck on old versions defeats the
point of running `update` in CI.

### 2. `--force` is global, and overwrites already-current-edited skills

`--force` is a single bare boolean that lifts the locally-edited guard
for every skill selected by the run. It has exactly one job in `update`:
discard local edits. The different-source guard from ADR 0001 is
unreachable here, because `update` only ever re-fetches from the
**recorded** `source` — never a new one — so there is no
different-source collision to guard against.

`--force` means "reconcile disk → upstream for any selected skill whose
disk differs from upstream, regardless of _why_ disk differs." This
includes the case where upstream hasn't moved but the user has hand-edited
the on-disk skill: `--force` re-syncs the on-disk content and the
manifest's `contentHash` back to the canonical upstream hash, so future
`update` runs are clean no-ops again. Treating that case as "skip because
upstream hasn't moved" would silently keep the user's edits — but they
asked `--force` precisely because they want to discard edits.

Without `--force`, any drift caused by local edits is a per-skill `✖
refused` outcome with a hint to re-run with `--force`. With `--force`,
the same skill prints `⚠ overwriting local edits in <name>` and is
overwritten.

Rejected alternative — `--force <name>` (per-skill value form). Rejected
because it duplicates the positional namespace and forces users to spell
names twice (`update foo bar --force foo bar`). The global form composes
with subset selection: `huuma skills update foo bar --force` overwrites
edits in `foo`/`bar` only. Rejected alternative — interactive per-skill
prompt. Rejected because it breaks CI/headless use, which the output
conventions (ADR 0001, this ADR §"Output shape") explicitly preserve;
`add` already refused interactivity for the same reason.

### 3. Upstream name change is a per-skill failure, not an auto-migrate

The install directory is `<skillsDir>/<name>/`, named after the recorded
skill name. If upstream's `SKILL.md` now declares a different `name`,
`validateSkill`'s `name` ≡ dir-basename invariant fails on the staging
dir (which is named after the _old_ name). `update` treats this as a
per-skill failure:

```
✖ <name>: upstream renamed the skill to '<new>'; remove and re-add to track it under the new name.
```

The on-disk skill and the manifest entry are left untouched. No swap, no
manifest mutation.

Rejected alternative — auto-migrate: rename the staging dir to the new
name, swap into `<skillsDir>/<new-name>/`, delete the old `<name>/` dir
and old manifest entry, write a new entry under `<new-name>`. Rejected
because it silently changes the registry key, which means every
reference the user has to `<name>` (notes, CI scripts, `.gitignore`
patterns, allow-lists) silently breaks. That is a high-blast-radius
surprise for a "just keep me current" command. A renamed skill is
genuinely a different skill identity, not a newer version of the same
one; `huuma skills remove <name>` + `huuma skills add --path=<new-url>`
is the honest model. If auto-migration is ever wanted, it is cleaner as
an explicit `huuma skills rename` or a `--migrate-renames` flag —
opt-in, with its own ADR. Default-off.

### 4. Missing-on-disk is a per-skill failure, not auto-repair or auto-prune

When the manifest has an entry for `<name>` but `.agents/skills/<name>/`
no longer exists (user `rm -rf`'d it, a previous run crashed mid-swap,
partial backup restore), `update` treats it as a per-skill failure:

```
✖ <name>: tracked in manifest but missing from disk; run 'huuma skills remove <name>' to clean up, or 'huuma skills add --path=<source-url>' to reinstall.
```

No fetch, no swap, manifest unchanged. Folded into the `failed` bucket
of the summary line (no separate `missing` bucket — the per-skill line
already carries the specifics).

Rejected alternative — auto-repair by re-fetching from the recorded
source. Rejected because `update`'s job is to refresh what the user
_has_, not resurrect what they _deleted_. A user who `rm -rf`'d a skill
on purpose would be startled to see it come back on the next `update`.
Rejected alternative — auto-prune the stale manifest entry. Rejected
because a user whose manifest got out of sync due to a crash deserves
an explicit signal that the registry is inconsistent, not a silent fix
that hides the underlying problem. Both repair and prune are real,
distinct operations with their own semantics — a future
`huuma skills repair`/`sync` could reinstall missing tracked skills,
and a future `huuma skills remove` (on ADR 0001's deferred list)
handles stale-entry cleanup. Auto-doing either inside `update` would
blur three commands into one.

This keeps the manifest write simple: `update` only ever writes entries
for skills it successfully swapped. It never deletes entries, never
re-creates entries for missing skills. One direction of mutation.

## Secondary decisions

The following are either direct consequences of ADR 0001 or low-stakes
defaults. Recorded here for the full picture; they did not each earn
their own load-bearing section.

### Re-fetch from the recorded `ref` — no tag ladder

`update` re-fetches from the `ref` stored in the manifest entry at
install time. "Latest" means "current tip of whatever `ref` you
originally pinned." A moving branch (`main`) advances; a tag or commit
SHA is a no-op modulo the hash check. Resolving a _newer_ tag/release
would require the GitHub REST API (rate limits, auth — the very things
ADR 0001 deliberately avoided) plus a notion of "newer" among
semver/non-semver tags. That is a separate command — `huuma skills
upgrade` or a `--ref=<new-ref>` flag — and would get its own ADR.

### Re-validate upstream, refuse on hard failure

The freshly-extracted upstream content is run through `validateSkill`
before swap, reusing ADR 0001's four mandatory invariants and its
warn-vs-reject split. A regressed upstream (dropped `SKILL.md`, broken
`name` regex, oversized `description`) is a per-skill `✖` failure, no
swap, on-disk skill untouched. Optional-field violations print as
yellow warnings and the skill still updates, matching `add`. Silently
swapping in a regressed skill would break the registry's contract:
"skills the user trusts enough to load into an agent."

### No-op detection via extract-then-hash — no GitHub REST dependency

Codeload returns bytes, not a content hash. The only zero-API way to
detect "upstream hasn't moved" is to extract the re-fetched tarball
into a staging dir, hash the staging tree with the existing
`contentHashOf`, and compare to the manifest's recorded `contentHash`.
Equal → already current, delete staging, no swap, no manifest write.
Different → validate (above), swap, update manifest.

This means every no-op skill pays one full extract + one hash. The cost
is bounded by `SIZE_CAP` (50 MB total, 10 MB/file from `extract.ts`)
and is paid once per `update` invocation. For the realistic 1–10 skill
registry it is seconds. ADR 0001 already flagged `resolvedSha` as a
future extension ("If richer 'branch moved A→B' metadata is wanted
later, a `resolvedSha` field can be added to the manifest schema
without migrating existing entries"); that is the right escape hatch
if no-op cost ever bites — store `resolvedSha`, compare tip SHA via
REST, only extract-on-mismatch. Not v1.

### One manifest write per run; no-ops leave the manifest untouched

Per-skill best-effort means each successful swap produces a new manifest
entry. The orchestrator collects the M updated entries in memory and
writes `.manifest.json` exactly once at the end of the run via the
existing atomic `writeManifest` (stage `.manifest.json.tmp` then
`rename`). No-op skills leave their `contentHash` and `installedAt`
untouched — `installedAt` keeps its meaning ("when this on-disk content
was first swapped in") and a no-op-only run writes nothing. Failed and
refused skills contribute nothing to the write.

If the final manifest write itself fails (disk full, permissions), the
M successfully-swapped skills are already on disk and the manifest lags
by M entries. Recovery is identical to `add`'s stance: re-running
`update` re-hashes disk, sees the new content, and writes the matching
entry. No corruption, just a transient inconsistency window.

### Sequential, sorted-by-name processing

Skills are processed one at a time in sorted-by-name order. This keeps
the streaming per-skill output (see "Output shape") readable, matches
`add`'s linear flow, and is polite to codeload's per-IP rate limiting
(a 20-way parallel burst is exactly the kind of load that triggers
throttles). The realistic registry size is 1–10 skills; the wall-clock
difference vs. bounded parallelism is single-digit seconds and not
worth the output-shape complexity. A `--concurrency=<n>` flag (default

1. is the right shape if parallelism is ever wanted — v2 concern.

### Stale-temp sweep once at the start

`update` calls `sweepStaleTemps(skillsDir)` once before processing any
skill, reusing `fs_utils.ts`'s existing helper verbatim. Per-skill
staging dirs follow the existing `.tmp-<rand>/staging/` →
`.tmp-<rand>/<name>/` pattern from `install.ts`, so stale dirs from a
crashed `update` are indistinguishable from stale dirs from a crashed
`add` — one sweeper handles both. Successful runs clean up their own
staging dirs (via `safeRemove(tempRoot)`), so no end-of-run sweep is
needed.

### Untracked skills are silently skipped

`update` is manifest-driven — it walks `.manifest.json`'s entries, not
`.agents/skills/`'s directories. Untracked skills (a directory with a
valid `SKILL.md` but no manifest entry) are never in scope; `update`
prints nothing about them, does not enumerate the filesystem top-level,
and is unaffected by the `.manifest.json` dotfile or `.tmp-*`/`.old-*`
stale dirs. A future `huuma skills list` (on ADR 0001's deferred list)
is the right home for "here's everything in `.agents/skills/`, marked
tracked vs. untracked"; `update` is a mutation command and does not
double as an inventory.

### Output shape and exit code

Inherits ADR 0001's colour vocabulary (`dim` for in-flight, `green ✓`
for success, `red ✖` for failure, `yellow ⚠` for non-fatal warnings)
and its CI/non-TTY-safe stance (no spinner, no interactivity). Per
skill, in sorted order:

```
… Checking <name>
✓ <name> is up to date (<owner>/<repo>@<ref>)
✓ <name> updated (<owner>/<repo>@<ref>)
⚠ overwriting local edits in <name>
✖ <name>: skill has local edits; re-run with --force to discard them
✖ <name>: fetch failed (HTTP 404 for <owner>/<repo>@<ref>)
✖ <name>: upstream validation failed (<reason>)
✖ <name>: upstream renamed the skill to '<new>'; remove and re-add to track it under the new name.
✖ <name>: tracked in manifest but missing from disk; run 'huuma skills remove <name>' to clean up, or 'huuma skills add --path=<source-url>' to reinstall.
✖ <name>: not tracked; nothing to update
```

Followed by one summary line:

```
Summary: updated <U> · up to date <C> · refused <R> · failed <F>
```

Exit code: `0` iff `R == 0 && F == 0`; `1` otherwise. Untracked/missing
names passed on the CLI count as `failed`. An empty registry (manifest
`skills: {}`, no names) prints `No tracked skills to update.` and exits
`0`.

### Command surface

New `src/skills/update.ts` owns the implementation, mirroring `add.ts`.
Registered in `src/skills/skills.ts`'s `Registry` as `["update"]` (no
short alias), so it appears in `huuma skills --help` automatically.

```
USAGE
  huuma skills update [NAMES...] [--force]

Re-fetches each tracked skill from the GitHub ref recorded in
.agents/skills/.manifest.json and updates the on-disk copy when upstream
has moved. With no names, updates every tracked skill. Untracked skills
are skipped. Locally edited tracked skills are not overwritten unless
--force is passed.

FLAGS
  --force     Overwrite skills whose on-disk content has been hand-edited
  -h, --help  Show this help
```

Positional `NAMES` are optional (zero = all tracked skills). Arg parsing
uses `@std/cli`'s `parseArgs`, same as `add`. No `--ref`, `--all`,
`--dry-run`, `--dir`, `--cwd`, `--token`, `--refetch` in v1 — each is
either redundant (zero-names default spells `--all`), out of scope
consistent with ADR 0001 (`--token`, `--dir`, `--cwd`), or the subject
of a future command (`--ref` → tag ladder; `--dry-run` → a future
`huuma skills status`/`outdated`).

### Testability

`update`'s orchestrator takes the same seams as `installSkill`:
`fetch?: (url: string) => Promise<ReadableStream<Uint8Array>>` (injected
codeload, production defaults to `downloadTarball`),
`log?: (line: string) => void` (output sink, production defaults to
`console.log`), and `cwd?: string` (project root, defaults to
`Deno.cwd()`). No manifest-injection seam — tests set up the on-disk
manifest fixture in a temp `cwd`, matching `install.ts`'s disk
round-trip. No `now?: () => Date` seam — `new Date().toISOString()` is
called directly, matching `install.ts`; `installedAt` is asserted only
as "is an ISO string."

Test cases mirror the per-skill outcome matrix: already current,
updated, locally-edited with and without `--force`, locally-edited but
already-current upstream (with and without `--force`), fetch failure,
upstream validation regression, upstream name change, missing on disk,
untracked name on CLI, mixed runs, no-op-only runs, `--force` with
nothing to discard, empty registry. Existing `testdata/valid-skill/`
and `testdata/manifest.fixture.json` are reused; cases needing
regressed/renamed upstream content use in-memory `@std/tar` tarballs,
matching `bundle_test.ts`.

## Considered but deferred

- `huuma skills list`, `remove`, `repair`/`sync` — all on ADR 0001's
  deferred list; `update` does not implement any of them.
- Tag-ladder resolution (`--ref=<new-ref>`, `huuma skills upgrade`) —
  see §"Re-fetch from the recorded `ref`".
- `--dry-run` — see §"Command surface"; a future `huuma skills
status`/`outdated` is the better home for read-only "what's behind"
  reporting.
- `--concurrency=<n>` — see §"Sequential, sorted-by-name processing".
- `--atomic` — see §"Per-skill best-effort, not atomic".
- Auto-migration of renamed upstream skills — see §"Upstream name
  change is a per-skill failure, not an auto-migrate".
- `resolvedSha` manifest field + GitHub REST tip-SHA comparison for
  cheap no-op detection — see §"No-op detection via extract-then-hash".
- README `### Updating skills` subsection — documentation, not a
  design decision; handled in the implementation pass alongside the
  code, matching how ADR 0001 updated the README when `add` shipped.
