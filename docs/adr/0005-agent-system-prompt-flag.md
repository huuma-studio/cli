# User-supplied system prompt via `--system-prompt` (replace, inline only)

Status: accepted

The agent ships a fixed `SYSTEM_PROMPT` ("You are Huuma Agent, a helpful
assistant running in a terminal. Answer concisely in plain text without markdown
formatting.") passed to every provider's `agent({...})` call. Users want to
override it per run to steer persona, output format, or constraints.

## Decision

Add a single CLI flag, `--system-prompt`, that supplies a system prompt as an
inline string. Both the space form and the `=` form are accepted, mirroring the
existing `--tools` flag:

```
huuma agent --system-prompt "Be terse." "fix the tests"
huuma agent --system-prompt="Be terse." "fix the tests"
```

**Replace semantics.** When the flag is supplied, its value entirely supplants
the built-in `SYSTEM_PROMPT` for that run. When the flag is absent, the built-in
is used unchanged. There is no append/prepend and no merging: a user who reaches
for a custom system prompt gets full control, including ownership of the output
style (the built-in's "plain text, no markdown" guardrail is gone for that run).

**Falsy value is an error.** A missing value (`huuma agent --system-prompt` with
no following token) and an empty/whitespace-only value (`--system-prompt ""` or
`--system-prompt=""`) both throw
`Missing value for --system-prompt. Example:
--system-prompt "Be a SQL expert."`.
There is no "run with no system prompt at all" escape hatch: you either pass
real text or you omit the flag and get the built-in. Overloading the empty
string as "erase the system prompt" would be a REPL footgun; a future
`--no-system-prompt` is the right shape for that niche if it is ever needed.

**Repeated flag: last wins.** `--system-prompt "A" --system-prompt "B"` resolves
to `"B"`, without error — the same override semantics a scalar option has
elsewhere.

**v1 is inline flag only.** No `--system-prompt-file` flag and no
`HUUMA_AGENT_SYSTEM_PROMPT` env var are added in this round.

## Context

The CLI already has a consistent run-configuration triad — flag, env var,
interactive prompt — used by `resolveModel` / `resolveApiKey` and the `--tools`
flag. The system prompt departs from that triad on purpose, for a security
reason specific to this CLI: the agent can be given `write_file` / `edit_file`
tools, and once it has them it can write to the filesystem during a run.

A **file-backed** system prompt (`--system-prompt-file ./prompt.md`) is
therefore a channel the agent can reach and overwrite mid-run, poisoning
subsequent runs that read the same file. An **env var**
(`HUUMA_AGENT_SYSTEM_PROMPT`) is worse: env vars are typically set in a shell rc
file (`~/.bashrc`, `~/.zshrc`, a `.env`), which is itself a file the agent can
edit with the file tools — so a prompt injected via env var can be silently
persisted across sessions by the agent itself.

Process **argv** is the one supply channel the agent cannot mutate during a run:
`Deno.args` is fixed at process start and no registered tool writes to it. The
inline `--system-prompt` flag lives in argv, so an agent that has gone rogue or
been prompt-injected cannot rewrite the system prompt that governs its own
future runs. That boundary is the reason v1 ships the inline flag and nothing
else.

A system prompt is also long, free-form, multi-line prose — awkward as an env
var and only ergonomic as an inline string for short one-liners. The file form
is the ergonomic choice for long prompts, but it is precisely the form the
security argument rules out for v1. A future revision may revisit file input
with mitigations (read-only resolve, a sandboxed prompt directory the file tools
are configured not to touch); that is out of scope here.

`parseAgentArgs` stops flag parsing at the first non-flag token (or `--`), so
`--system-prompt` must precede the user prompt, matching `--tools`. The space
form consumes exactly one argv token as its value (shell quoting keeps prose
intact); unquoted multi-word values are a user error, not handled specially,
identical to how `--tools` behaves.

## Consequences

- **`parseAgentArgs`** gains a `systemPrompt: string | undefined` field
  (`undefined` = flag absent → use built-in; a non-empty string = supplied). The
  field is `undefined`, not `""`, so the absence-vs-empty distinction is
  preserved for the caller and the falsy-throws rule lives entirely in the
  parser.
- **`setup`** takes the system prompt as a second argument and computes
  `systemPrompt ?? SYSTEM_PROMPT` once, threading it into each provider's
  `agent({...})` call. The built-in `SYSTEM_PROMPT` constant stays as the
  default.
- **Output style is the user's responsibility when the flag is used.** REPL
  output may contain markdown / long responses because the built-in "concise,
  plain text" line is replaced, not retained. This is intentional and called out
  in the help text.
- **`agentHelp()`** and the README `agent` section list `--system-prompt`; the
  "Unknown flag" error message now names both `--tools` and `--system-prompt`.
- **No env var, no file flag, no interactive prompt** for the system prompt in
  v1. Adding any of them later is a breaking-ish change to the configuration
  surface and must re-evaluate the file/env security argument above.
- **Tests** cover the parser: space form, `=` form, missing value, empty value
  (space and `=`), whitespace-only, repeated flag (last wins), and ordering
  relative to `--tools` and the positional prompt. Threading into `agent()` is
  not unit-tested, mirroring the existing `setup` coverage which only asserts
  rejection of an unknown provider.

## Alternatives considered

- **Append / prepend the user's prompt to the built-in.** Rejected — users who
  ask for a custom system prompt want control over framing and output style, and
  the built-in's "plain text, no markdown" line would either contradict the
  user's intent or silently override it. Replace is honest about what "custom"
  means.
- **Replace but re-inject the formatting guardrail as a separate, untouchable
  line.** Considered as the "principled" option to keep REPL output readable. It
  adds machinery (splitting the built-in into identity vs. format parts, a
  second prompt field through `setup`) and still half-betray's the user's
  control. Dropped for v1 simplicity; a future `--keep-formatting` toggle is the
  right shape if the guardrail needs preserving.
- **`--system-prompt-file` and/or `HUUMA_AGENT_SYSTEM_PROMPT`.** Rejected for v1
  on the security argument in Context: both are channels a tooled agent can
  rewrite, so they cannot be the _first_ surface offered. Revisit with
  mitigations later.
- **Interactive "add a system prompt?" prompt in the REPL.** Rejected — it
  complicates REPL startup and the one-shot path, and a user who wants a custom
  system prompt almost always already has the text. The inline flag covers the
  short case; a file form (with mitigations) would cover the long case later.
- **Accumulate repeated `--system-prompt` values like `--tools`.** Rejected — a
  system prompt is a scalar string, not a list; concatenation semantics would be
  surprising. Last-wins is the predictable scalar override.
