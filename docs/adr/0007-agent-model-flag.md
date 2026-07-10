# Model selection via `--model provider/model` (flag only, no env vars)

Status: accepted

The agent's provider and model were configured through the `HUUMA_AGENT_PROVIDER`
and `HUUMA_AGENT_MODEL` env vars, falling back to interactive prompts. Both env
vars are removed in favor of a single CLI flag.

## Decision

Add a `--model` flag that selects the provider and model for one run as a
single `provider/model` value. Both the space form and the `=` form are
accepted, mirroring `--tools` and `--system-prompt`:

```
huuma agent --model anthropic/claude-haiku-4-5 "explain git rebase"
huuma agent --model=ollama/llama3.2 "explain git rebase"
```

**One value, split on the first slash.** The token before the first `/` is the
provider (normalized to lowercase); everything after it is the model id,
verbatim — model ids on OpenAI-compatible routers may themselves contain
slashes (`--model openai/meta-llama/Llama-3-8b`).

**Both parts are required.** A missing value throws
`Missing value for --model. Example: --model anthropic/claude-haiku-4-5`; a
value without a slash or with an empty provider or model part throws
`Invalid --model value "...". Expected provider/model`. Provider names are
validated in `setup()`, where an unknown one throws
`Unknown provider "...". Use --model <provider>/<model> with one of:
anthropic, openai, ollama.`

**Repeated flag: last wins**, matching `--system-prompt`'s scalar semantics.

**The interactive prompts remain the fallback.** Without the flag, the agent
asks for a provider and model exactly as before. There is no longer any env
var that skips those two prompts.

**`HUUMA_AGENT_API_KEY` and `HUUMA_AGENT_HOST` stay env vars.** Secrets do not
belong in argv (visible in `ps`, shell history); the Ollama host keeps its
existing env/prompt pair unchanged.

## Context

ADR 0006 established the security boundary this decision extends: with file
tools (`write_file`, `edit_file`) or the `cli` tool enabled, the agent can
rewrite the files that populate env vars — a shell rc, a `.env` — so any
env-backed behavior channel can be poisoned mid-run and persist across
sessions. `HUUMA_AGENT_PROVIDER`/`HUUMA_AGENT_MODEL` steer which model
governs future runs, which makes them exactly such a channel: a
prompt-injected agent could silently repoint subsequent `huuma agent` calls
at a different provider or model. Process argv is the one supply channel the
agent cannot mutate during a run, so model selection moves there.

The API key is knowingly left on the env channel. Rewriting it cannot
redirect a run to an attacker-chosen model (the provider endpoints are fixed
in code) — at worst it breaks runs — and the alternative, a key in argv,
leaks a real secret to the process list and shell history. The host var is
Ollama connection config with the same secret-adjacent shape; both stay put.

The combined `provider/model` format (rather than two flags) keeps the pair
atomic: a model id is meaningless without its provider, and two flags would
invite a half-specified state that still needs one interactive prompt.

## Consequences

- **`parseAgentArgs`** gains a `model: ModelSelection | undefined` field
  (`{ provider, modelId }`); structural validation (slash, non-empty parts)
  lives in the parser, provider-name validation in `setup()`.
- **`setup`** takes the selection as a third argument;
  `resolveModel(selected, fallback)` returns the flag's model id or prompts.
  `envValue` reads for `HUUMA_AGENT_PROVIDER` and `HUUMA_AGENT_MODEL` are
  gone.
- **Breaking change** for users who set the env vars: the same run is now
  spelled `--model provider/model` on the command line. README, `agentHelp()`
  and the "Unknown flag" error are updated.
- **Sub-agents inherit the selection** unchanged — presets run on the parent's
  resolved model (ADR 0005), however it was chosen.

## Alternatives considered

- **Keep the env vars with flag precedence.** Rejected: the poisonable channel
  would remain live; precedence only helps when the user happens to pass the
  flag.
- **Separate `--provider` and `--model` flags.** Rejected: the pair is atomic,
  and one flag keeps the surface small and un-half-specifiable.
- **An allow-list or confirmation for env-var changes instead.** Rejected: the
  CLI cannot observe what edits an agent makes through its file tools, let
  alone attribute them to config files.
