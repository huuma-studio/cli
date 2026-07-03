# Implementation Plan — `huuma agent --system-prompt`

## Goal

Let a user override the agent's built-in `SYSTEM_PROMPT` for a single run via an
inline `--system-prompt` flag. Replace semantics; inline string only (no file
flag, no env var) — see ADR 0005 for the security rationale.

## Conventions

- Mirror the existing `--tools` flag's parsing shape (space form + `=` form,
  throw on missing value, stop flag parsing at the first non-flag token / `--`).
- Keep changes surgical: `parseAgentArgs`, `setup`, the default export,
  `agentHelp`, the unknown-flag message, the README, and tests.
- Do not touch the REPL loop, `respond`, `modelText`, or the provider branches
  beyond threading the resolved system prompt through.
- Type-check + format + lint + test must stay green (`deno task check`,
  `deno fmt --check`, `deno lint`, `deno task test`).

## File map (modified)

- `src/agent/agent.ts` — parser, `setup` signature, default export, help text,
  unknown-flag message.
- `src/agent/agent_test.ts` — parser tests for `--system-prompt`; help-text
  assertion.
- `README.md` — `agent` section: document `--system-prompt`.
- `docs/CONTEXT.md` — glossary entry (done).
- `docs/adr/0005-agent-system-prompt-flag.md` — ADR (done).

No new files in `src/`.

## Implementation order

### Step 1 — `parseAgentArgs`

- Add `systemPrompt: string | undefined` to the return type. `undefined` = flag
  absent; a non-empty string = supplied.
- In the loop, alongside the `--tools` / `--tool` branch, add:
  - `arg === "--system-prompt"`: read `args[++i]`; if falsy or whitespace-only,
    throw
    `Missing value for --system-prompt. Example: --system-prompt "Be a SQL
    expert."`;
    otherwise assign (last-wins, no accumulation).
  - An inline check for `--system-prompt=`: extract the value after `=`; same
    falsy/whitespace throw; assign.
- Keep the existing `inlineValue` (tools) helper untouched; add a sibling for
  the system-prompt `=` form so the two flags don't cross-match.
- Update the unknown-flag error to:
  `Unknown flag "{arg}". The agent accepts
  --tools <list> and --system-prompt <text>.`
- Return `{ tools, systemPrompt, prompt, help }`.

### Step 2 — `setup`

- Change signature to `setup(toolNames: string[] = [], systemPrompt?: string)`:
  `Promise<Assistant>`.
- Compute `const prompt = systemPrompt ?? SYSTEM_PROMPT;` once at the top (after
  `resolveTools`, before provider selection) and pass `systemPrompt: prompt` in
  all three provider branches, replacing the three literal `SYSTEM_PROMPT`
  references.

### Step 3 — default export

- Pass `parsed.systemPrompt` as the second argument to `setup`.

### Step 4 — `agentHelp`

- Add to OPTIONS:
  `--system-prompt <text>  Replace the built-in system prompt for this run`
- Add an example:
  `huuma agent --system-prompt "Be a SQL expert, answer only in SQL." "select all users"`
- Note in a line that the custom prompt _replaces_ the default (so output style
  is the user's).

### Step 5 — tests

Parser tests (parallel to the existing `--tools` tests):

- space form: `--system-prompt "Be terse." "fix the tests"` →
  `{ tools: [], systemPrompt: "Be terse.", prompt: "fix the tests", help: false }`
- `=` form: `--system-prompt="Be terse." go` → systemPrompt `"Be terse."`,
  prompt `"go"`.
- missing value: `--system-prompt` (end of args) throws "Missing value for
  --system-prompt".
- missing value before another flag: `--system-prompt --tools grep "x"` —
  mirrors `--tools`'s behaviour (the next token is consumed as the value); not a
  special case, but document via a test if it is stable.
- empty value (space): `--system-prompt ""` throws.
- empty value (`=`): `--system-prompt=""` throws.
- whitespace-only: `--system-prompt "   "` throws.
- repeated flag: `--system-prompt "A" --system-prompt "B"` → `"B"`, no error.
- combined: `--tools grep --system-prompt "Be terse." "fix tests"` → tools
  `["grep"]`, systemPrompt `"Be terse."`, prompt `"fix tests"`.
- ordering: `--system-prompt "Be terse." -- "literal --words"` → systemPrompt
  set, prompt `"literal --words"`.

Help test: assert `agentHelp()` output includes `--system-prompt`.

### Step 6 — README

- Add `--system-prompt` to the agent OPTIONS table / usage block, with a
  one-line note that it replaces the built-in for the run.

## Final validation

```
deno task check
deno fmt --check
deno lint
deno task test
```

## Out of scope (per ADR 0005)

- `--system-prompt-file` flag.
- `HUUMA_AGENT_SYSTEM_PROMPT` env var.
- Interactive "add a system prompt?" prompt.
- Append/prepend/merge semantics.
- `--no-system-prompt` (zero-framing) escape hatch.
