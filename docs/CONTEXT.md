# Context — Huuma CLI

> Glossary for the Huuma CLI codebase. Implementation details belong in ADRs,
> not here. Keep this file a pure dictionary of canonical terms.

## Skill

A directory conforming to the [Agent Skills specification](https://agentskills.io/specification):
a `SKILL.md` file with required `name` and `description` YAML frontmatter,
plus optional `scripts/`, `references/`, and `assets/` directories. A skill is
intended to extend an AI agent's behavior. Within a Huuma project, a skill
lives under `.agents/skills/<name>/`.

The term **skill** is _not_ used for the agent's `--tools` flags. Those are
**tools**, not skills.

## Skill source

A location a skill can be installed from. The first supported skill source is
a GitHub repository path; other source kinds (e.g. local paths, tarballs,
other git hosts) may be added later.

## Skill registry

The set of skills currently installed in a project's `.agents/skills/`
directory. Not yet built; the `huuma skills add` command is the first step
toward managing it.

## Registry state

A skill in `.agents/skills/` is in exactly one of three states, distinguished
by what `.agents/skills/.manifest.json` knows about it:

**Tracked skill**:
A skill with a manifest entry (a recorded `source` and `contentHash`). The
registry knows where it came from and what it looked like at install time.

**Untracked skill**:
A skill directory under `.agents/skills/` with no manifest entry — for
example, one a user copied in by hand, or one whose manifest was lost. The
registry does not know a source for it, so there is nothing to re-fetch.

**Locally edited skill**:
A tracked skill whose on-disk content hash no longer matches its recorded
`contentHash` — the user hand-edited it after install.

_Avoid_: Manual skill (use one of the three states above)

## Skills update

Re-fetch each tracked skill from its recorded source and bring it to the
latest version of that source. Untracked skills are skipped (there is no
source to fetch from). Locally edited skills are not overwritten without
`--force`, mirroring `huuma skills add`'s collision policy.

## Skill bundle

A set of skills installed together from a single skill source in one atomic
operation. Introduced by the project-scaffolding flow: a project type may
offer a skill bundle (e.g. the `website` type offers the skills under
`huuma-studio/ui`'s `skills/` directory). The bundle is discovered dynamically
— every subdirectory of the source's `skills/` subpath that contains a
valid `SKILL.md` is a member of the bundle. Installation is all-or-nothing:
if any member fails validation, none of the bundle is installed.

A skill bundle is not the same as the skill registry. The bundle is the input
set offered at scaffolding time; the registry is the resulting installed
set. A bundle becomes (part of) the registry on successful install.

_Avoid_: Skill pack, skill set, skill collection
