# Plan — Agent Skills tool for `huuma agent`

> Decision settled in `docs/adr/0009-agent-skills-default-tool.md`. This plan
> covers implementation only. Implemented against `@huuma/ai@^0.0.14`, the
> release that exports the `skills` factory **and** defaults its path to
> `.agents/skills`. The CLI still passes that path explicitly (see ADR 0009),
> insulating the agent's scan target from any future change to the library
> default.

## Goal

Give every `huuma agent` run the Agent-Skills discovery tools (`list_skills`

- `retrieve_skill`) so the model can find and follow installed skills in
  `.agents/skills/`. Skills are a **baseline capability**, on by default — not
  an opt-in `--tools` selection — because progressive disclosure of project
  know-how is orthogonal to the action tools (`files`, `cli`, `grep`, `search`,
  sub-agents) the user selects with `--tools`. A new `--skills-path <dir>` flag
  overrides the directory; the library default (`.agents/skills`) applies when
  the flag is absent.

```
huuma agent "What does this project do?"          # skills on by default
huuma agent --skills-path ./other-skills "..."    # redirect the scan
huuma agent --tools files,cli --cli-commands deno,git "run the tests"
                                                  # skills still on, plus actions
```

## Scope

In scope:

- Bump `@huuma/ai` to `^0.0.14` (the first release exporting `skills` and
  defaulting its path to `.agents/skills`).
- Register `skills` in `TOOL_FACTORIES` so it expands to `list_skills` +
  `retrieve_skill`, and construct it as a baseline in `setup()` for every run.
- `--skills-path <dir>` flag (space and `=` forms, last-wins, non-empty value)
  threading `AgentArgs` → `SetupOptions` → the skills factory.
- Help text, README, and `docs/CONTEXT.md` updates; tests.

Out of scope (per ADR 0009):

- An opt-out (`--no-skills`). Skills are lenient about a missing directory (the
  library yields an empty list), so always-on is harmless; revisit only if a
  real need appears.
- A `--skills-on-warning` override or a custom `onWarning` channel; the
  library's `console.warn` default stands for v1.
- Re-scanning disk mid-run; a run reuses one factory's cached scan. Re-scan by
  restarting the agent (matches the library's caching contract).

## Technical findings

### Skills is a baseline, not a `--tools` toggle (ADR 0009)

Two coherent models were considered:

- **Model A — always-on baseline.** `setup()` always builds the skills pair and
  prepends it; `--tools` adds action tools on top. Skills are never off.
- **Model B — default selection, explicit replaces.** Omitting `--tools`
  defaults to `["skills"]`; passing `--tools` gives exactly that list (skills
  only if listed). Requires tracking whether `--tools` was specified at all
  (today `AgentArgs.tools: string[]` cannot distinguish "omitted" from
  "`--tools=` empty").

ADR 0009 picks **Model A**: it matches the Agent-Skills philosophy (the host
always offers discovery; the model decides when a skill applies), needs no
`toolsSpecified` plumbing, and the library's leniency on a missing directory
means always-on costs nothing in a project without skills. Model B is rejected
because dropping project know-how just because the user asked for `grep` is
surprising, and it adds parse-state to preserve a "plain chat" escape hatch that
the leniency of skills makes unnecessary.

### Register in `TOOL_FACTORIES` anyway, dedupe via the agent's tool map

Even though skills are always-on, `skills` is also registered in
`TOOL_FACTORIES` so:

- `--tools skills` is a valid, no-op-yet-explicit spelling (discoverability),
- `allToolNames()` and the help TOOLS list include it, and
- the unknown-name error message stays the single source of truth.

The agent's `Tools` collection is a name-keyed map (`@huuma/ai/tools`), so
listing `skills` in `--tools` alongside the always-on baseline dedupes to one
pair — no double registration. To avoid **double-scanning** (two factory
instances each caching its own read of `.agents/skills/`), `setup()` checks
whether the user's `--tools` already includes `skills` (case-insensitive) and
skips the prepend in that case. One scan, one cache, regardless of how skills
were requested.

### The CLI owns the default path and its resolution

`@huuma/ai`'s `skills({ path })` factory defaults `path` to `./skills` in 0.0.13
and `.agents/skills` only from 0.0.14 onward. Relying on the library default
would couple the agent's scan target to the library's release version, so the
CLI passes `path` explicitly — `path ?? ".agents/skills"`. The factory still
resolves it to an absolute path eagerly via `resolve(path)` against
`Deno.cwd()`, so a relative path is sufficient and the CLI does no `Deno.cwd()`
threading. The existing `huuma skills add` / `huuma skills update` install into
`<cwd>/.agents/skills/`, so the default points where skills already land. The
factory is lenient about a missing directory (`NotFound` → empty list), so
always-on costs nothing in a project with no skills.

### Leniency and permissions

The factory is lenient: a missing skills directory yields an empty list
(`NotFound` is swallowed); a folder without `SKILL.md` is skipped silently;
other load failures go through `onWarning` (default `console.warn`) and the
skill is skipped. The CLI is installed with `deno install -A` (all perms), so a
`PermissionDenied` on `.agents/skills/` is not a realistic runtime path; the
only noisy case is a _present but unreadable_ skills directory, accepted for v1.

### Config stays in flags (ADR 0008)

`--skills-path` is a behavioral flag, never an env var, mirroring `--host` and
`--search-engine`. A missing or empty value is rejected with an example,
following the `--model` / `--system-prompt` precedent. There is no env fallback.

## Implementation steps

### 1. Bump `@huuma/ai`

**Files:** `deno.json`, `deno.lock`

`jsr:@huuma/ai@^0.0.12` → `jsr:@huuma/ai@^0.0.14`, refresh the lockfile. 0.0.14
exports `skills` and defaults its path to `.agents/skills`; the CLI still passes
the path explicitly, so the scan target is independent of the library default.
Note 0.0.x caret semantics pin the version exactly, so the bump must be
explicit. Deno 2.9's `--minimum-dependency-age` gate blocks packages published
within ~24h, so the first resolve needs `--minimum-dependency-age=0`; subsequent
runs use the cached/locked version. Gate on `deno task check` + the existing
agent tests before any feature work.

### 2. `skills` factory entry + config

**File:** `src/agent/tools.ts`

- Import `skills` from `@huuma/ai/tools`.
- Add `skillsPath?: string` to `ToolConfig`.
- Add an exported `skillsTool(path)` wrapper that calls
  `skills({ path: path ?? ".agents/skills" })` — the CLI owns the default path
  rather than relying on the library's (which differs across releases).
- Register `skills: (config) => skillsTool(config.skillsPath)` in
  `TOOL_FACTORIES`. The entry expands to two tools (`list_skills`,
  `retrieve_skill`), like `files` expands to five.

### 3. Parse `--skills-path`

**File:** `src/agent/args.ts`

- Add `skillsPath: string | undefined` to `AgentArgs` (and to the `--help`
  early-return object).
- Add a `valueFlag("--skills-path", "--skills-path ./.agents/skills")` branch,
  last-wins like `--host` / `--search-engine`.
- Extend the unknown-flag error message to name `--skills-path`.

### 4. Wire skills as a default baseline

**Files:** `src/agent/setup.ts`, `src/agent/agent.ts`

- Add `skillsPath?: string` to `SetupOptions`.
- Extract `resolveAgentTools(options)` from `setup()`: it calls `resolveTools`
  with `{ cliCommands, searchEngine, skillsPath }` and builds the skills
  baseline via `skillsTool(skillsPath)` **unless** the user's `--tools` already
  lists `skills` (case-insensitive) — one factory, one scan. Returns
  `{ tools,
  subagentNames, skillsBaseline }`. Extracted so the always-on
  behavior is testable without a provider.
- `setup()` calls `resolveAgentTools` and prepends the baseline in `build()`:
  `tools: [...skillsBaseline, ...tools, ...resolveSubagents(...)]`.
- `agentHelp()`: update the `--tools` line to note skills are on by default; add
  an OPTIONS entry for `--skills-path <dir>`; the TOOLS list auto-includes
  `skills` via `allToolNames()` — add a parenthetical that `skills` expands to
  `list_skills, retrieve_skill` (like the `files` note) and is always enabled.

### 5. Tests

**Files:** `src/agent/tools_test.ts`, `src/agent/args_test.ts`,
`src/agent/setup_test.ts`, `src/agent/agent_test.ts`

- `tools_test.ts`:
  - `resolveTools(["skills"])` returns tool names
    `["list_skills",
    "retrieve_skill"]` (pins the expansion, parallels the
    `files` test).
  - `resolveTools(["skills"], { skillsPath: <tmp> })` wires the path — assert
    via a scan of a temp skills dir (write a `SKILL.md`, call `list_skills`,
    check the entry) or, if the library exposes it, via the resolved path.
- `args_test.ts`:
  - Add `skillsPath: undefined` to the `parsed()` baseline.
  - `--skills-path ./x` space form, `--skills-path=./x` `=` form, last-wins on
    repetition, and the missing/empty-value error.
- `setup_test.ts`:
  - With no `--tools`, the built assistant's tools include `list_skills` and
    `retrieve_skill` (skills are a default).
  - With `--tools grep`, skills are still present alongside `grep`.
  - `--skills-path` redirects the scan (point at a temp dir with a fixture skill
    and assert `list_skills` reads it).
- `agent_test.ts`:
  - `assertStringIncludes(result, "--skills-path")` in the help test, next to
    the existing `--host` check; assert the help states skills are on by
    default.

### 6. Docs

**Files:** `docs/adr/0009-agent-skills-default-tool.md`, `README.md`,
`docs/CONTEXT.md`

- ADR 0009 records the Model A decision and the rejected Model B.
- README: change "By default the agent only chats" to reflect that skills
  discovery is always on; add `--skills-path` to the options table and one
  example; note `skills` is always enabled and `--tools` adds actions on top.
- `docs/CONTEXT.md`: add a "Skills tool" glossary entry (`list_skills` /
  `retrieve_skill`, default `.agents/skills/`, `--skills-path`), and clarify the
  existing "Skill" entry's relationship to the agent's always-on discovery.

## File map

```
deno.json                                       # edit — bump @huuma/ai to ^0.0.14
deno.lock                                        # regenerate
src/agent/tools.ts                              # edit — skills factory + config
src/agent/args.ts                               # edit — --skills-path parsing
src/agent/setup.ts                              # edit — skills as default baseline
src/agent/agent.ts                              # edit — help text
src/agent/tools_test.ts                         # edit — expansion + path wiring
src/agent/args_test.ts                          # edit — --skills-path cases
src/agent/setup_test.ts                         # edit — default-on + redirect
src/agent/agent_test.ts                         # edit — help assertions
docs/adr/0009-agent-skills-default-tool.md      # new — decision
README.md                                        # edit — default behavior + flag
docs/CONTEXT.md                                  # edit — Skills tool glossary
docs/specs/add-agent-skills-tool/PLAN.md        # this file
docs/specs/add-agent-skills-tool/TASKS.json     # task tracking
```

## Risks

- **Double scan if dedupe is missed.** If `setup()` prepends the skills pair
  without checking whether `--tools` already listed `skills`, two factory
  instances scan disk and cache separately. Mitigation: the already-listed check
  in step 4.
- **Behavioral shift from "plain chat by default."** A bare `huuma agent` now
  advertises two tools to the model. Skills are lenient (empty list when none
  installed), so the practical effect is nil without skills, but the model may
  call `list_skills` unprompted. ADR 0009 accepts this as the point of
  progressive disclosure.
- **Permission noise on a present-but-unreadable skills dir.** The CLI is
  installed with `-A`, so this is not a realistic runtime path; noted for
  completeness. The library's `onWarning` (`console.warn`) surfaces per-skill
  load failures; v1 keeps the default.
- **Dependency weight.** The 0.0.14 bump may pull new transitive deps into the
  lockfile; `deno task check` gates before feature work.

## Out of scope

- `--no-skills` opt-out (revisit only with a demonstrated need).
- A custom `onWarning` channel or `--skills-on-warning` flag.
- Mid-run re-scan of `.agents/skills/` (a run reuses one cached scan; restart to
  re-scan, per the library contract).
- Skills appearing in the `huuma skills` management command's output — that
  command manages installation; the agent tool discovers what is installed.
