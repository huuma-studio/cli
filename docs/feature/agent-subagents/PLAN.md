# Plan — Preset sub-agents for `huuma agent`

> Design decisions are settled in `docs/adr/0005-agent-preset-subagents.md`
> and the new glossary terms in `docs/CONTEXT.md` (Sub-agent, Preset
> sub-agent, Delegation). This plan covers implementation only.

## Goal

Let `huuma agent --tools explorer` give the parent model a read-only
research sub-agent it can delegate to. The parent decides when to delegate,
guided by the preset's tool description; the sub-agent runs `read_file` +
`grep` on the parent's provider/model and returns concise findings. One dim
status line marks each delegation.

## Scope

In scope:

- Bump `@huuma/ai` to `^0.0.12` (subagent factory ships in 0.0.9+;
  `^0.0.8` pins 0.0.8 exactly under 0.0.x caret semantics).
- `SUBAGENT_FACTORIES` registry and two-phase tool construction in
  `src/agent/agent.ts`.
- The `explorer` preset in `src/agent/subagents.ts`.
- Dim delegation status line via the preset's `onMessage`.
- Help text and README updates; tests.

Out of scope (per ADR 0005):

- Any second preset (write-capable `worker` — own ADR later).
- User-defined sub-agents; `HUUMA_AGENT_SUBAGENT_MODEL`.
- Turn bounds (`maxTurns` is upstream's future control).
- Interleaving sub-agent transcripts into parent output.

## Technical findings

### Two-phase construction preserves fail-early

`setup()` builds tools before the provider prompt so bad input fails first.
Preset construction needs the resolved model, so:

- `resolveTools(names)` validates every name against the **union** of
  `TOOL_FACTORIES` and `SUBAGENT_FACTORIES` keys, builds the eager tools,
  and returns the preset names still pending.
- After provider/model resolution, `resolveSubagents(pending, { model,
  modelId })` builds the preset tools and appends them.

Unknown-name errors and `cli`/`search` config errors keep their current
timing; only preset construction moves later. Both help text and the
unknown-name error message list the union of both registries so they cannot
drift.

### The `explorer` preset

- Tool name `explorer`; description instructs the parent to send
  self-contained prompts (no history crosses the boundary — `@huuma/ai`
  ADR 0001) and states what comes back: concise findings.
- Sub-agent: `agent({ model, modelId, systemPrompt, tools: [readFile(),
  grep()], onMessage })` wrapped with `subagent({ name, description,
  agent })` from `@huuma/ai/tools`.
- System prompt: read-only investigator; report findings, not transcripts;
  plain text.

### Delegation status line vs the `Thinking...` spinner

`respond()` writes `Thinking...` with no trailing newline. The preset's
`onMessage` fires for the user prompt, model messages, and tool results;
filter to `role === "user"` (exactly one per delegation) and print:
`write(CLEAR_LINE)`, then a dim `explorer ← <truncated prompt>` line via
`console.log`, then re-write the dim `Thinking...` so the spinner survives.
Truncate the prompt to one terminal-friendly line (~60 chars). Concurrent
delegations in one parent turn each print their own line; lines are whole,
so there is no interleaving problem.

### Version bump surface

0.0.9–0.0.12 added media input, MCP tools, skills, and the subagent factory.
`agent().run(prompt, history)`, `AgentOptions`, and the tool factories used
here are shape-compatible; `deno task check` + the existing agent tests
gate the bump before any new code lands.

## Implementation steps

### 1. Bump `@huuma/ai`

**Files:** `deno.json`, `deno.lock`

`jsr:@huuma/ai@^0.0.8` → `jsr:@huuma/ai@^0.0.12`, refresh the lockfile,
run check/tests before touching agent code.

### 2. Two-phase tool construction

**File:** `src/agent/agent.ts`

- `resolveTools(names)` returns `{ tools, subagentNames }`; unknown names
  throw with the union of both registries in the message.
- `setup()` calls `resolveSubagents(subagentNames, { model, modelId })`
  after each provider branch resolves, before constructing the parent
  `agent(...)`. Factor the per-provider duplication if it stays readable.
- `agentHelp()` lists both registries; add a SUBAGENTS line describing
  `explorer` in one sentence.

### 3. The `explorer` preset

**File:** `src/agent/subagents.ts` (new)

- Export `SUBAGENT_FACTORIES: Record<string, (ctx: SubagentContext) =>
  AgentTools>` with the single `explorer` entry, plus the `SubagentContext`
  type (`{ model, modelId }` — typed loosely enough to accept any provider
  adapter, mirroring how `setup()` handles the generic).
- `onMessage` filters to user messages and prints the dim delegation line
  (see Technical findings). Import `write`, `dim`, `CLEAR_LINE` from
  `../terminal.ts`.

### 4. Tests

**Files:** `src/agent/agent_test.ts`, `src/agent/subagents_test.ts` (new)

- Unknown tool name still throws before any model exists, and the message
  now includes `explorer`.
- `resolveTools(["explorer"])` succeeds without a model and defers the
  preset; `resolveTools(["explorer", "grep"])` builds `grep` eagerly.
- `resolveSubagents(["explorer"], ctx)` with a stub model returns one tool
  named `explorer` whose description mentions self-contained prompts.
- Delegation through the preset returns the sub-agent's final text (stub
  model scripted like `@huuma/ai`'s own subagent tests).
- Help output lists `explorer`.

### 5. README

**File:** `README.md`

If the agent section documents `--tools`, add `explorer` with one sentence;
otherwise leave `--help` as the source of truth.

### 6. Validate

- `deno task check`, `deno lint`, `deno task test` (or this repo's
  equivalents from `deno.json`).
- Manual smoke: `huuma agent --tools explorer "What does src/mod.ts
  export?"` against a real provider — confirm the dim delegation line
  appears and findings come back.

## File map

```
deno.json                          # edit — bump @huuma/ai
deno.lock                          # regenerate
src/agent/agent.ts                 # edit — two-phase construction, help
src/agent/subagents.ts             # new — explorer preset registry
src/agent/agent_test.ts            # edit — validation/help cases
src/agent/subagents_test.ts        # new — preset construction/delegation
README.md                          # edit — maybe, one sentence
docs/CONTEXT.md                    # done — glossary terms
docs/adr/0005-agent-preset-subagents.md  # done — decision
docs/feature/agent-subagents/PLAN.md     # this file
docs/feature/agent-subagents/TASKS.json  # task tracking
```

## Risks

- **Unbounded delegated runs.** Accepted in ADR 0005; revisit when
  upstream `maxTurns` lands. The dim delegation line is the only
  mitigation (a visibly stuck run can be Ctrl+C'd).
- **Delegation prompt quality depends on the parent model.** The default
  parent is a small model (`claude-haiku-4-5`); a vague delegation prompt
  yields vague findings, and the tool description is the only lever.
- **Dependency weight.** The bump pulls 0.0.12's new transitive deps (MCP
  SDK, sandbox, etc.) into the lockfile even though the agent uses none of
  them yet.
