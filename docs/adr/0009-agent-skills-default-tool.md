# Agent Skills tool, on by default

Status: accepted

## Context

The CLI's `huuma skills add` / `huuma skills update` manage a project's
`.agents/skills/` directory, but the agent itself has no way to _use_ an
installed skill. `@huuma/ai@0.0.14` exports a `skills()` tool factory that
returns two tools — `list_skills` and `retrieve_skill` — implementing the
[Agent Skills](https://agentskills.io/specification) progressive-disclosure
pattern: the model lists cheap `{ name, description }` pairs, then retrieves one
skill's full instructions (and its folder path) when a request matches.

Until now `huuma agent` has been a plain chat by default, with tools opt-in via
`--tools`. Adding skills raises a design question: are they an opt-in `--tools`
selection like `grep` or `files`, or a baseline capability?

## Decision

**Skills are a baseline capability, on for every `huuma agent` run.** `setup()`
always builds the `list_skills` + `retrieve_skill` pair and prepends it to the
agent's tools; `--tools` adds _action_ tools on top and does not gate skill
discovery. The skills directory defaults to `.agents/skills/` — owned by the
CLI, not the library (see below) — and is overridable with a new
`--skills-path <dir>` flag.

```
huuma agent "What does this project do?"          # skills on by default
huuma agent --skills-path ./other-skills "..."    # redirect the scan
huuma agent --tools files,cli --cli-commands deno,git "run the tests"
                                                  # skills still on, plus actions
```

`skills` is also registered in `TOOL_FACTORIES` so `--tools skills` is a valid,
explicit no-op and `allToolNames()` / the help TOOLS list include it. To avoid
double-scanning, `setup()` skips the always-on prepend when the user's `--tools`
already lists `skills` — one factory, one cached scan either way. The agent's
`Tools` collection is a name-keyed map, so any accidental overlap dedupes to a
single pair.

### The CLI owns the default path, not the library

`@huuma/ai`'s `skills({ path })` factory defaults `path` to `./skills` in 0.0.13
and `.agents/skills` from 0.0.14 onward. Relying on the library default would
couple the agent's scan target to the library's release version, so the CLI
passes `path` explicitly — `path ?? ".agents/skills"` — so the scan targets the
directory `huuma skills add` / `huuma skills update` install into on every
supported `@huuma/ai` release. The factory still resolves the path to an
absolute one eagerly via `resolve(path)` against `Deno.cwd()`, so a relative
path is sufficient and no `Deno.cwd()` threading is needed.

The factory is lenient about a missing directory (`NotFound` → empty list), so
always-on costs nothing in a project with no skills installed. The CLI is
installed with `deno install -A`, so a `PermissionDenied` on `.agents/skills/`
is not a realistic runtime path; the only noisy case is a _present but
unreadable_ skills directory, accepted for v1.

### Config stays in flags (ADR 0008)

`--skills-path` is a behavioral flag, never an env var, mirroring `--host` and
`--search-engine`. A missing or empty value is rejected with an example,
following the `--model` / `--system-prompt` precedent. There is no env fallback.

## Consequences

- A bare `huuma agent` now advertises two tools (`list_skills`,
  `retrieve_skill`) to the model. The practical effect is nil without installed
  skills (the scan returns `[]`), but the model may call `list_skills`
  unprompted — that is the point of progressive disclosure.
- The README's "By default the agent only chats" line is updated to reflect that
  skills discovery is always on; `--tools` adds actions on top.
- `parseAgentArgs` gains `skillsPath: string | undefined`; `SetupOptions` and
  the `ToolConfig` passed to `resolveTools` gain `skillsPath?: string`. The
  unknown-flag error and `agentHelp()` list `--skills-path`.
- The ENVIRONMENT section is unchanged — `--skills-path` is a path, not a
  secret, and argv is visible in `ps`; only API keys stay in the environment.
- No `--no-skills` opt-out in v1. Skills are lenient about a missing directory;
  revisit only if a real need appears.

## Alternatives considered

- **Model B — default selection, explicit replaces.** Omitting `--tools`
  defaults to `["skills"]`; passing `--tools` gives exactly that list (skills
  only if listed). Rejected: dropping a project's installed know-how just
  because the user asked for `grep` is surprising, and it requires tracking
  whether `--tools` was specified at all (today `AgentArgs.tools: string[]`
  cannot distinguish "omitted" from "`--tools=` empty") to preserve a "plain
  chat" escape hatch that the library's leniency makes unnecessary.
- **Always-on with an `--no-skills` escape hatch.** Rejected for v1: adds a flag
  for a need that has not been demonstrated, and the leniency on a missing
  directory already covers the "no skills here" case silently.
- **Skills as a pure `--tools` opt-in (not default).** Rejected: it hides
  installed skills from the common case. The whole point of installing a skill
  via `huuma skills add` is for the agent to use it; requiring a
  `--tools skills` reminder every run defeats the install.
- **A config file or env var for the skills path.** Rejected per ADR 0008:
  behavioral config lives in argv so a tooled agent cannot poison it.

## Out of scope

- `--no-skills` opt-out (revisit only with a demonstrated need).
- A custom `onWarning` channel or `--skills-on-warning` flag; the library's
  `console.warn` default stands for v1.
- Mid-run re-scan of `.agents/skills/`; a run reuses one factory's cached scan,
  per the library contract. Restart to re-scan.
