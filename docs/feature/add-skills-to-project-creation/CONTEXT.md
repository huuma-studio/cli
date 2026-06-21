# Context — Add skills to project creation

> Glossary for the "add skills to project creation" feature. Implementation
> details belong in ADRs, not here. Foundational skill terms (`Skill`, `Skill
> source`, `Skill registry`) are defined in
> [the skills-management glossary](../skills-management/CONTEXT.md); this file
> only adds the terms this feature introduces.

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
