# Context — Huuma CLI

> Glossary for the Huuma CLI codebase. Implementation details belong in ADRs,
> not here. Keep this file a pure dictionary of canonical terms.

## Skill

A directory conforming to the [Agent Skills specification](https://agentskills.io/specification):
a `SKILL.md` file with required `name` and `description` YAML frontmatter,
plus optional `scripts/`, `references/`, and `assets/` directories. A skill is
intended to extend an AI agent's behavior. Within a Huuma project, a skill
lives under `.agents/skills/<name>/`.

The term **skill** is *not* used for the agent's `--tools` flags. Those are
**tools**, not skills.

## Skill source

A location a skill can be installed from. The first supported skill source is
a GitHub repository path; other source kinds (e.g. local paths, tarballs,
other git hosts) may be added later.

## Skill registry

The set of skills currently installed in a project's `.agents/skills/`
directory. Not yet built; the `huuma skills add` command is the first step
toward managing it.
