# `huuma skills add` — design decisions

Status: accepted

`huuma skills add --path=<github-url>` installs a skill from a public GitHub
repository into the current project's `.agents/skills/` directory. The command
introduces the first sub-command structure (`skills` parent with sub-commands)
and the first install-from-remote-source flow in the CLI. This ADR records the
load-bearing decisions; the glossary terms (`Skill`, `Skill source`, `Skill
registry`) live in `CONTEXT.md`.

## Path grammar

Accepted form, mandatory `tree/<ref>`:

```
https://github.com/<owner>/<repo>/tree/<ref>[/<subpath>]
```

- `<owner>`, `<repo>`: non-empty, no `/`.
- `<ref>`: a single path segment (no `/`). Branch names containing slashes
  (e.g. `feature/foo`) are **rejected** with a hint to use a tag or top-level
  branch. Rejected to avoid URL ambiguity (`tree/feature/foo/skills/bar` cannot
  be split unambiguously); revisit only if a real user is blocked.
- `<subpath>`: zero or more non-empty segments; the skill directory is
  `<subpath>` resolved against the repo root, or the repo root when absent.

Shorthand (`owner/repo`), bare repo URLs without `tree/<ref>`, `blob/` URLs,
`.git` suffixes, non-`https`, and non-`github.com` hosts are rejected. This
keeps v1 deterministic and the pinned ref always visible in the input.

Examples covered:

- `https://github.com/anthropics/skills/tree/main/skills/mcp-builder`
- `https://github.com/mattpocock/skills/tree/main/skills/engineering/codebase-design`

## Fetch mechanism — codeload tarball, not `git clone`

Fetch `https://codeload.github.com/<owner>/<repo>/tar.gz/<ref>`, gzip-decompress
via the built-in `DecompressionStream("gzip")`, and walk the tar with
`@std/tar` (UNSTABLE `v0.1.x`, pinned via `deno.lock`), copying only entries
under `<subpath>/`.

Rejected alternatives:

- `git clone` + sparse-checkout: requires the `git` binary on `$PATH` and
  pulls object history we don't need for a one-shot install.
- GitHub REST API subtree fetch: rate-limited (60 req/h anonymous), drags in
  auth handling for private repos, none of which is in v1 scope.

Tarball is chosen because install is one-shot (not a working clone), needs no
external binary, and resolves branch/tag/SHA all in one code path. Public
repos only for v1; private-repo auth deferred.

## Tarball safety guards

Three guards applied to every extraction regardless of the underlying parser:

1. **Path-traversal reject** — any entry whose extracted path escapes the
   install directory (`..` segments or absolute paths) is rejected and aborts
   the install.
2. **Symlinks skipped** — symlinks are not recreated on disk. The Agent Skills
   spec does not mention symlinks; recreating them into `.agents/skills/` is a
   security risk (a malicious skill could symlink `assets/../../.ssh/id_rsa`).
3. **Size cap** — total extracted bytes and per-file bytes are capped to defuse
   tar-bomb-style repos. Exact numbers are tunable constants in the code.

## Skill validation — at install time, two-tier

Validated against the [Agent Skills spec](https://agentskills.io/specification)
before the skill is copied into its final location, using `@std/front-matter`
(wrapping `@std/yaml`).

Reject hard on the four mandatory invariants:

- `SKILL.md` present at the skill-dir root.
- `name` present, 1–64 chars, `^[a-z0-9]+(-[a-z0-9]+)*$` (lowercase alnum +
  hyphens, no leading/trailing/double hyphens).
- `name` matches the skill's parent directory name.
- `description` present, 1–1024 chars.

Warn (yellow) but install on optional-field violations (`license`,
`compatibility` > 500 chars, `metadata` non-string values, `allowed-tools`).
Optional fields don't break skill identity and the author can fix them in
place later.

The install directory is named after the validated frontmatter `name`, so the
spec's `name` ≡ parent-dir invariant holds post-install regardless of the
source repo's subpath depth.

## Install target and atomicity

Target: `<cwd>/.agents/skills/<name>/`. `cwd` is taken as the project root; no
upward search for a project marker (`deno.json` / `.agents/`) is performed —
the user runs `huuma skills add` from the right directory. `.agents/skills/`
and `.agents/` are created if missing.

Stage-then-swap to avoid leaving a half-installed skill on failure:

1. Extract + validate into `.agents/skills/.tmp-<name>-<rand>/`.
2. If `.agents/skills/<name>/` already exists (collision path — see below):
   rename it to `.agents/skills/.old-<name>-<rand>/` first, then rename the
   temp dir into place. If the final rename fails, restore the `.old-...` dir.
3. Recursively delete `.agents/skills/.old-<name>-<rand>/`.
4. On any error before step 2, delete the temp dir and leave the existing
   install untouched.

At the start of every `add` run, stale `.tmp-*` and `.old-*` directories left
over from a previously crashed invocation are swept (best-effort, errors
ignored).

## Collision policy — source-aware, with `--force`

`add` looks up the incoming skill's `name` in the manifest (see Fingerprinting
below):

- **Not installed** → install.
- **Installed, same `owner/repo`** (ref may differ) → overwrite. Treats `add`
  as "I want the latest of this source's skill."
- **Installed, different `owner/repo`** → refuse unless `--force`, with a
  message naming both sources. Protects against accidental clobber of a
  same-named-but-different skill.
- **Installed but the on-disk content hash no longer matches the manifest**
  (user has edited the installed skill locally since install) → refuse even
  for same-source unless `--force`, with a message: _"Skill `<name>` has local
  edits. Re-run with `--force` to discard them."_

`--force` is shipped in v1 alongside `--path` so collision handling is never
user-hostile.

## Fingerprinting — content hash, not commit SHA

Each installed skill is recorded in `.agents/skills/.manifest.json` (a
dotfile at the skills root, clearly not a skill directory; future `list`
implementations must skip dotfiles). Entry shape:

```json
{
  "skills": {
    "mcp-builder": {
      "source": {
        "owner": "anthropics",
        "repo": "skills",
        "ref": "main",
        "subpath": "skills/mcp-builder"
      },
      "contentHash": "sha256-...",
      "installedAt": "2026-06-18T12:00:00Z"
    }
  }
}
```

The fingerprint is a SHA-256 over the installed tree (sorted path + bytes),
computed locally with no network calls. Chosen over a commit-SHA fingerprint
because v1 is zero-API and public-repos-only; a content hash is enough to make
a future `huuma skills update` work (re-fetch from the stored `ref`, compare
hashes, overwrite if different) without any GitHub REST dependency. The hash
also doubles as a tamper-detection signal: a manifest/disk hash mismatch means
the user has hand-edited the installed skill, which triggers the local-edits
refuse path above.

If richer "branch moved A→B" metadata is wanted later, a `resolvedSha` field
can be added to the manifest schema without migrating existing entries; old
entries simply lack it.

## Command surface

New `src/skills/skills.ts` owns its own `Registry` of sub-commands, mirroring
`src/project/project.ts`. `src/mod.ts` registers `["skills"]` as a top-level
command (no short alias in v1). `src/skills/add.ts` implements `add`.

v1 flags for `add`:

- `--path=<value>` — required, the GitHub URL per the grammar above. Both
  `--path=value` and `--path value` forms are accepted.
- `--force` — optional boolean, the collision/edited-skill escape hatch.
- `--help` / `-h` — print usage.

No `--ref`, `--token`, `--dir`, `--cwd`, or `--dry-run` in v1; ref is embedded in
the URL, private repos and dry-run are out of scope, and the user is expected
to run from the correct `cwd`. No short forms (`-p`, `-f`) — keeps the surface
minimal and unambiguous, matching the user-specified
`huuma skills add --path=...` shape.

Arg parsing uses `@std/cli`'s `parseArgs` (added to `deno.json` imports) rather
than a hand-rolled parser, for consistency with the broader Deno ecosystem and
to get unknown-option rejection and alias handling for free.

## Output conventions

In-flight steps are printed with `dim("… " + msg)` lines (no spinner, so the
style also works in CI/non-TTY):

```
… Resolving anthropics/skills@main
… Downloading anthropics/skills@main
… Extracting skills/mcp-builder
… Validating SKILL.md
… Installing to .agents/skills/mcp-builder/
```

Success: `green("✓")` + plain message naming the skill, source ref, and target.
Failure: `red("✖")` + message to `console.error`, `Deno.exitCode = 1`,
`return ""` — matching the existing `agent.ts` pattern. A `yellow` helper is
added to `src/terminal.ts` for optional-field validation warnings, keeping the
colour set centralized.

## Permissions

The CLI is installed with `deno install -A`, so end users grant all perms at
install time. For source/dev/test runs, `skills add` requires `--allow-net`
(codeload), `--allow-read` (collision/manifest checks), and `--allow-write`
(create install dir + manifest).

Tests that exercise the live network path declare `permissions: { net: true }`
per-test and self-skip when net is unavailable, so the rest of the suite still
runs offline. The `deno.json` `test` task is bumped to include
`--allow-net --allow-write`.

## Considered but deferred

- `huuma skills list`, `update`, `remove` — out of scope; `add` is the first
  step toward a Skill registry.
- `/`-containing branch names — rejected for v1.
- Private-repo auth (`--token`, env var) — v1 is public repos only.
- Commit-SHA fingerprinting — content hash is sufficient for a future
  `update`.
- `git clone`-based fetch — revisit if a future `update` flow wants working
  trees.
