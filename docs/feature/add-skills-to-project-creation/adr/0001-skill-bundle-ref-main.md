# Skill bundle source ref — `main`, not a pinned tag

Status: accepted

When scaffolding a project type that offers a skill bundle (the `website` type
pulls from `huuma-studio/ui`), the bundle is fetched from the source repo's
`main` branch rather than a pinned tag or a JSR-version-derived ref.

`main` is `huuma-studio/ui`'s productive branch: features merge only when
ready to release, so `main` is always in a shippable state. This keeps the
scaffolded skills in lockstep with upstream for free — a new skill added to
`huuma/ui` reaches scaffolders without a CLI release — and matches what a
user would get by running `huuma skills add --path=…/tree/main/skills/<name>`
manually.

Rejected: pinning a tag (creates a release-coupling that re-introduces the
maintenance contract we explicitly rejected by discovering skills
dynamically); resolving the ref from the JSR package version (JSR versions
don't map 1:1 to git tags, and the path grammar bans `/`-containing refs, so
this would assert a tagging convention about a repo whose tagging policy we
don't own).

Trade-off: scaffolds are not reproducible across `main` moving. Acceptable
because `huuma-studio/ui` is first-party and trusted, and the per-skill
manifest entries record `ref: "main"` plus a content hash, so a future
`huuma skills update` can detect drift. If third-party skill sources are
added to the bundle flow later, revisit pinning for those.
