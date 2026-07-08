# `huuma agent` delegates via baked-in preset sub-agents

Status: accepted

`@huuma/ai@0.0.12` ships a `subagent` tool factory (its ADR 0001,
"Delegation as a tool factory"): a pre-configured `Agent` wrapped as a tool;
the parent model supplies only a self-contained prompt and receives the
sub-agent's final text. This ADR decides how `huuma agent` adopts it.

## Context

`huuma agent` serves two purposes at once: it is a showcase for `@huuma/ai`
capabilities, and it is intended to grow into a genuinely useful terminal
agent. Features must satisfy both — wired in a way that demonstrates the
library *and* is usable, not merely present.

The CLI pins `@huuma/ai@^0.0.8`, which predates the subagent factory;
adopting it requires bumping to `^0.0.12` (for `0.0.x` versions, caret
ranges pin the exact patch, so the bump is explicit).

Tool construction today is eager and model-free: `TOOL_FACTORIES` in
`src/agent/agent.ts` are zero-arg and run before the provider/model is
resolved, deliberately, so a bad `--tools` name or missing tool config
fails before any interactive prompt. A sub-agent, however, needs a
`model` + `modelId` at construction time — adopting delegation forces part
of tool construction to happen after provider resolution.

## Decision

- **Delegation is model-initiated.** The parent model decides when to
  delegate, guided solely by the preset's tool `name` and `description`
  (the mechanism `@huuma/ai`'s ADR 0001 designed for). The CLI adds no
  delegation heuristics of its own.
- **Presets are baked in.** Sub-agents are defined by this CLI — name,
  description, system prompt, and toolset are product surface maintained
  here. User-defined sub-agents (config file, flags) are out of scope; they
  would require designing a configuration language and can be layered on
  later without conflicting with presets.
- **v1 ships exactly one preset: `explorer`.** Read-only investigation —
  `read_file` and `grep` only, a system prompt that demands concise
  findings, and a tool description that instructs the parent to send
  self-contained prompts (no history crosses the boundary). The toolset is
  deliberately config-free: presets embedding `cli` or `search` would drag
  env-var validation into the delegation path and reopen the fail-early
  ordering question. A write-capable `worker` preset is deferred to its own
  ADR.
- **Presets are opt-in via `--tools`, like every other tool.** No
  default-on, no separate flag. "The model self-decides" therefore only
  applies once the user has enabled the preset — accepted, because
  default-on would break the CLI's default-no-tools contract and stack
  token-spend risk on top of the accepted run-length risk below.
- **The sub-agent inherits the parent's provider and model.** No
  `HUUMA_AGENT_SUBAGENT_MODEL` override in v1; every env var is documented
  surface and no one has asked for cheaper delegated models yet.
- **One dim status line per delegation, nothing more.** The preset's
  construction-time `onMessage` (the observation point `@huuma/ai`'s ADR
  sanctions) prints a single dim line when a delegation starts. The
  sub-agent's transcript is never interleaved into the parent's output —
  the attribution problem `@huuma/ai`'s ADR 0001 explicitly rejected.
- **Run-length risk is accepted as-is, for now.** `@huuma/ai`'s `Agent.run`
  has no turn bound, and its own plan names a general `maxTurns` on `Agent`
  as the right future control. A delegating agent multiplies unbounded
  loops. We ship without a bound — the parent loop is already unbounded and
  the CLI is documented as early-development — and adopt `maxTurns` when it
  lands upstream. This is tracked debt, not an endorsement.

### Consequence: two-phase tool construction

Rather than making every factory model-aware, preset sub-agents live in a
second registry (`SUBAGENT_FACTORIES`, keyed like `TOOL_FACTORIES` but
taking a `{ model, modelId }` context). Name validation covers the union of
both registries up front, so unknown-name errors still precede any
interactive prompt; existing zero-arg factories stay eager, so `cli`/
`search` config errors also keep failing early. Only preset construction
moves after provider resolution.

## Alternatives considered

- **Preset sub-agents enabled by default.** Rejected: breaks the
  default-no-tools contract and puts multi-loop token spend one model whim
  away from a plain question, compounding the accepted no-`maxTurns` risk.
- **A dedicated `--subagents` flag.** Rejected: a second enablement
  mechanism blurs the tool vocabulary this repo deliberately keeps strict
  (see `docs/CONTEXT.md`).
- **`HUUMA_AGENT_SUBAGENT_MODEL` override.** Deferred: undemanded
  configuration surface; inherit-only is simpler and showcase-honest.
- **Multiple presets in v1 (e.g. a write-capable `worker`).** Deferred:
  each preset is named, documented, maintained surface; `explorer` proves
  the mechanism first.
- **Blocking the feature on `maxTurns` landing upstream.** Rejected for
  now: the parent loop is equally unbounded today, so delegation changes
  the multiplier, not the category; revisit when upstream ships it.
- **User-defined sub-agents.** Deferred: requires a configuration language;
  presets do not preclude it.
