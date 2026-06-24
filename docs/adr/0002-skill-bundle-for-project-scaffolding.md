# `huuma project website` skill bundle — design decisions

Status: accepted

When a user runs `huuma project` and selects the `website` type, an opt-in
prompt offers a **skill bundle** from `huuma-studio/ui`'s `skills/`
directory. On accept, every subdirectory of that `skills/` subpath that
contains a valid `SKILL.md` is installed into the new project's
`.agents/skills/<name>/` and recorded in the manifest — atomically.

This ADR records the load-bearing decisions introduced by the bundle layer.
It builds on `docs/adr/0001-huuma-skills-add.md` (single-skill install) and
the glossary terms (`Skill`, `Skill source`, `Skill registry`, `Skill
bundle`) live in `docs/CONTEXT.md`.

## Bundle source — `huuma-studio/ui` @ `main`

The website scaffold pins `huuma-studio/ui` as a JSR dependency
(`jsr:@huuma/ui@^0.2`) in the generated `deno.json`. The skill bundle
comes from the same repository's `skills/` directory, fetched via the
existing codeload tarball mechanism from `src/skills/fetch.ts`.

The ref is the `main` branch. `huuma-studio/ui` does not publish git
version tags, so a version-pinned ref is not available. This makes bundle
installs reproducible only at point-in-time — a later `main` commit yields
different members. Drift is detected the same way single-skill drift is:
the manifest stores a content hash, and a future `huuma skills update`
re-fetches from `main` and compares hashes.

Rejected alternatives:

- **Resolve the ref via `latest("@huuma/ui", "^0.2")` and use the JSR
  version as a git tag.** Rejected because the repo has no version tags;
  the codeload fetch would 404. Coupling the bundle ref to the JSR
  version would also require a fallback path that adds complexity for no
  gain in v1.
- **Pin to a commit SHA.** Reproducible, but the SHA would have to be
  maintained by hand in the CLI source and re-pinned on every `@huuma/ui`
  release. Not worth the maintenance cost for a v1 opt-in bundle.

`main` is chosen because it matches the skills-management ADR's canonical
example (`anthropics/skills@main`), needs no extra plumbing, and aligns
with how the bundle is meant to be used: "give me the skills that match
this version of `@huuma/ui`."

## Bundle discovery — every `skills/` subdir with a valid `SKILL.md`

The bundle is discovered dynamically: `extractSkill` (from `extract.ts`)
is called once with `subpath: ["skills"]`, which strips the tarball's top
dir and the `skills/` prefix, leaving `staging/` with one subdirectory per
source skill. The orchestrator walks `staging/` and treats every immediate
subdirectory that contains a `SKILL.md` as a candidate member.

Non-skill entries (README-only dirs, dotfiles, files at the staging root)
are silently skipped — they are not bundle members and never reach
`validate.ts`.

## Manifest shape — each member is a standalone entry

Each installed member is recorded in `.agents/skills/.manifest.json` as a
normal `ManifestEntry`, identical in shape to one written by
`huuma skills add`, with one difference: `source.subpath` is
`["skills", <memberName>]` per member, not the bundle's `["skills"]`.

This is the load-bearing decision. A bundle install of N members produces
N manifest entries; there is no `bundle:` marker, no grouping, no
"bundle identity" stored anywhere. Consequences:

- A future `huuma skills update` re-fetches each member individually from
  `huuma-studio/ui` @ `main` and compares its content hash. It does not
  need to know the member came from a bundle.
- A future `huuma skills remove` deletes one member without touching the
  others.
- A user who later runs `huuma skills add` on the same `subpath` as a
  bundle member gets the same manifest entry (same-source overwrite path
  from the single-skill ADR) — no special bundle-vs-add branching.

Rejected alternative: a single manifest entry with a `bundle: { members:
[...] }` field. Rejected because it requires every future registry
operation (`update`, `remove`, `list`) to special-case bundles, and
because it breaks the "skill = one directory, one entry" invariant that
the single-skill ADR established. The per-member-entry shape keeps the
registry a flat map keyed by skill name.

## Atomicity — all-or-nothing up to the swap phase

`docs/CONTEXT.md` mandates all-or-nothing: "if any member fails validation,
none of the bundle is installed." This ADR fixes _where_ the
all-or-nothing boundary sits.

The bundle orchestrator (`src/skills/bundle.ts`) runs in two phases:

1. **Validation phase** — every candidate member is validated in
   deterministic (sorted) order before any member is moved into
   `.agents/skills/`. The tarball is downloaded once and extracted into
   a single staging dir under `.agents/skills/.tmp-<rand>/staging/`. If
   any member fails `validateSkill`, the entire staging dir is removed
   and `BundleValidationError` is thrown. No member directory appears
   under `.agents/skills/` on this path. This is the strict
   all-or-nothing guarantee.

2. **Swap phase** — once all members have validated, each is moved from
   `staging/<name>/` to `.agents/skills/<name>/` via the existing
   `swapDirectory` helper. This phase is not strictly atomic across
   members: if a rename fails mid-bundle, the orchestrator attempts a
   best-effort rollback (move already-swapped members back to staging),
   then rethrows. If rollback itself fails, the partial state is left
   for the next `sweepStaleTemps` run — matching the single-skill
   orchestrator's stance.

The boundary is at the swap phase because enforcing strict atomicity
across N filesystem renames would require either a transactional
filesystem (not available) or shadow-copying every member before any
swap (doubling disk I/O for the common success case). The chosen split
makes the common path — all members validate, all swaps succeed — pay
no extra cost, and pushes the rare partial-failure case to best-effort
rollback plus the existing sweep cleanup.

## Collision policy — not applicable in v1

The single-skill ADR defines a collision matrix
(`none` / `same-source` / `different-source` / local edits) consulted
before swap. The bundle orchestrator does **not** implement this matrix.

Reason: the bundle is only invoked from the `website` scaffold, where
the target project is freshly created and `.agents/skills/` does not
exist. There is nothing to collide with. Implementing the full collision
matrix would require deciding `--force` semantics for partial-overlap
bundles in existing projects — which is the scope of a future
`huuma skills add-bundle` CLI command (see Out of scope).

If a bundle install _does_ encounter an existing skill dir (e.g.
because the user re-ran the scaffold into a non-empty dir),
`swapDirectory`'s existing-target path handles it as a same-name
overwrite without source comparison. This is acceptable for v1 because
the only caller is the fresh-scaffold flow; documenting this as a known
limitation rather than implementing the matrix keeps the bundle
orchestrator small.

## Failure severity — non-fatal to the scaffold

The bundle prompt runs _after_ the project structure has been written
(`createDir`, `denoConfig`, `rootTs`, `appTs`, optional Tailwind/Zed/VS
Code all done). On any bundle failure (network down, `huuma-studio/ui`
404, a member with malformed `SKILL.md`, atomicity abort), the
orchestrator:

- prints `red("✖ …")` to stderr,
- sets `Deno.exitCode = 1`,
- returns `{ members: [] }` from the website helper,
- and the scaffold still returns `"Website application created!"`.

The user gets a working website project without the skills. This is a
deliberate choice: skills are an enhancement, not a project requirement.
A half-scaffolded website with no `deno.json` is broken; a
fully-scaffolded website with no skills is just a website without agent
extensions. Treating the bundle as fatal would roll back nothing useful
(the files are already written) and would make the scaffold fragile to
transient network conditions.

Rejected alternative: treat bundle failure as fatal and exit before the
success line. Rejected because the failure leaves the project in a
working state — there is nothing to abort, only a warning to surface.
`Deno.exitCode = 1` is enough for CI to detect the partial failure.

## Prompt — opt-in, no default yes

`confirm("Add skills bundle from @huuma/ui?")` is called with no
`defaultValue` argument, so `confirm` defaults to `false` (Enter = `N`).
This matches the existing `.zed` / `.vscode` / Tailwind prompts in the
website scaffold: every additive, opt-in feature asks for an explicit
`y`.

Installing third-party code into a new project is the kind of action
that should require an explicit yes, not a default yes on Enter.

## Testability — one seam on the website helper

`installBundle` (in `src/skills/bundle.ts`) accepts an injected `fetch`
seam, mirroring `installSkill`'s seam. `bundle_test.ts` uses it to drive
the orchestrator with in-memory `@std/tar` tarballs — no network, no
fixtures, deterministic.

The website helper (`installBundleForWebsite`) is unit-tested through a
single optional `bundle?` seam: the test injects a function that either
returns a fixed `BundleResult` (asserting pass-through) or throws a
`BundleValidationError` (asserting the non-fatal swallow +
`Deno.exitCode = 1` path). The default export calls the helper with no
seam in production. No `ref?` seam is needed because the ref is
hard-coded `main` — there is nothing dynamic to inject.

## Considered but deferred

- A `huuma skills add-bundle` CLI subcommand. Surfacing the bundle
  installer as a user-facing command for _existing_ projects requires
  collision-policy decisions (partial overlap, `--force` semantics,
  member removal on re-install) that the fresh-scaffold flow does not
  need. Separate feature, separate ADR.
- Selective bundle install (choosing a subset of members). `docs/CONTEXT.md`
  fixes v1 as all-or-nothing.
- A `bundle:` marker in the manifest. See "Manifest shape" — rejected
  for v1 and unlikely to be added later; the per-member-entry shape is
  strictly more flexible.
- `.gitignore` for `.agents/` in the scaffolded project. Whether to
  exclude `.agents/` (runtime artifacts) or commit it (team
  reproducibility) is a product decision handled by a dedicated feature,
  not by this ADR.
- Non-`main` refs, private-repo auth, non-GitHub sources — inherited
  from `0001`'s out-of-scope list.
