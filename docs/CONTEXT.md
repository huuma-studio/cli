# Context — Huuma CLI

> Glossary for the Huuma CLI codebase. Implementation details belong in ADRs,
> not here. Keep this file a pure dictionary of canonical terms.

## Skill

A directory conforming to the
[Agent Skills specification](https://agentskills.io/specification): a `SKILL.md`
file with required `name` and `description` YAML frontmatter, plus optional
`scripts/`, `references/`, and `assets/` directories. A skill is intended to
extend an AI agent's behavior. Within a Huuma project, a skill lives under
`.agents/skills/<name>/`.

The term **skill** is _not_ used for the agent's `--tools` flags. Those are
**tools**, not skills. The agent's always-on `list_skills` / `retrieve_skill`
tools are the **skills tools** — see that entry below.

## Skills tools

The `list_skills` and `retrieve_skill` tools `huuma agent` exposes on every run
(ADR 0009), implementing the Agent-Skills progressive-disclosure pattern: the
model lists cheap `{ name, description }` pairs, then retrieves one skill's full
instructions (and its folder path) when a request matches. They scan
`.agents/skills/` by default — the directory `huuma skills add` /
`huuma
skills update` install into — overridable with `--skills-path <dir>`.
Skills tools are a baseline capability, on regardless of `--tools`; `--tools`
adds action tools on top and does not gate skill discovery. A missing directory
is lenient (the tools report an empty list), so the always-on baseline is
harmless in a project with no skills installed.

## Skill source

A location a skill can be installed from. The first supported skill source is a
GitHub repository path; other source kinds (e.g. local paths, tarballs, other
git hosts) may be added later.

## Skill registry

The set of skills currently installed in a project's `.agents/skills/`
directory. Not yet built; the `huuma skills add` command is the first step
toward managing it.

## Registry state

A skill in `.agents/skills/` is in exactly one of three states, distinguished by
what `.agents/skills/.manifest.json` knows about it:

**Tracked skill**: A skill with a manifest entry (a recorded `source` and
`contentHash`). The registry knows where it came from and what it looked like at
install time.

**Untracked skill**: A skill directory under `.agents/skills/` with no manifest
entry — for example, one a user copied in by hand, or one whose manifest was
lost. The registry does not know a source for it, so there is nothing to
re-fetch.

**Locally edited skill**: A tracked skill whose on-disk content hash no longer
matches its recorded `contentHash` — the user hand-edited it after install.

_Avoid_: Manual skill (use one of the three states above)

## Skills update

Re-fetch each tracked skill from its recorded source and bring it to the latest
version of that source. Untracked skills are skipped (there is no source to
fetch from). Locally edited skills are not overwritten without `--force`,
mirroring `huuma skills add`'s collision policy.

## System prompt

The provider-level instruction that frames an agent run — persona, output
format, constraints — passed as `systemPrompt` to `agent({...})` for every
provider (anthropic, openai, ollama). The CLI ships a built-in `SYSTEM_PROMPT`
used when no override is supplied.

A **custom system prompt** is one supplied by the user via the `--system-prompt`
flag. It **replaces** the built-in for that run (no merging, no append), so the
user owns the output style. v1 accepts the inline flag only — no file flag, no
env var — because a tooled agent (one with `write_file` / `edit_file`) could
rewrite a file- or env-backed prompt and poison future runs; process argv is the
one channel the agent cannot mutate mid-run. See ADR 0006.

_Avoid_: system message, pre-prompt, instruction (use **system prompt**).

## Skill bundle

A set of skills installed together from a single skill source in one atomic
operation. Introduced by the project-scaffolding flow: a project type may offer
a skill bundle (e.g. the `website` type offers the skills under
`huuma-studio/ui`'s `skills/` directory). The bundle is discovered dynamically —
every subdirectory of the source's `skills/` subpath that contains a valid
`SKILL.md` is a member of the bundle. Installation is all-or-nothing: if any
member fails validation, none of the bundle is installed.

A skill bundle is not the same as the skill registry. The bundle is the input
set offered at scaffolding time; the registry is the resulting installed set. A
bundle becomes (part of) the registry on successful install.

_Avoid_: Skill pack, skill set, skill collection

## Sub-agent

An `@huuma/ai` `Agent` wrapped as a tool via the library's `subagent` factory
and invoked by the `huuma agent` parent model. The sub-agent runs its own
orchestration loop (own system prompt and toolset) and returns only its final
text; no conversation history is shared in either direction, so every delegation
prompt must be self-contained.

## Preset sub-agent

A sub-agent defined by this CLI: its tool name, description, system prompt, and
toolset are fixed product surface maintained here. A preset sub-agent is a
**tool** (an entry on the `--tools` flag), not a skill. The first preset is
`explorer`. User-defined sub-agents are not supported.

_Avoid_: Custom sub-agent, dynamic sub-agent

## Delegation

The parent agent calling a preset sub-agent's tool with a self-contained prompt.
Delegation is model-initiated: the parent model decides when to delegate, guided
only by the preset's tool name and description. The CLI adds no delegation
heuristics of its own.
