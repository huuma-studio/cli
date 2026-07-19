# Huuma CLI

[![JSR Score](https://jsr.io/badges/@huuma/cli/score)](https://jsr.io/@huuma/cli)
[![JSR Version](https://jsr.io/badges/@huuma/cli)](https://jsr.io/@huuma/cli)

Huuma CLI is a command-line tool for creating and managing Huuma applications.
It provides utility commands to streamline Huuma application development.

> **Note**: Huuma CLI is currently in early development. Options and commands
> might change in future versions. Use with caution!

## Installation

```bash
deno install -A -f -g -r -n huuma jsr:@huuma/cli
```

## Usage

```
huuma [OPTIONS] [COMMAND]
```

### Options

| Option          | Description                       |
| --------------- | --------------------------------- |
| `-h, --help`    | Display help information          |
| `-V, --version` | Show current version of Huuma CLI |

### Commands

| Command      | Description                             |
| ------------ | --------------------------------------- |
| `p, project` | Create a new project structure          |
| `a, agent`   | Chat with an AI agent in your terminal  |
| `s, skills`  | Manage skills for your project          |
| `u, upgrade` | Upgrade Huuma CLI to the latest version |

## Creating a New Project

You can create a new Huuma project with the following command:

```bash
huuma project
```

Run `huuma project --help` to see the available project types and options.

The CLI will prompt you for:

1. Project name - The name of your new project (will be created as a directory)
2. Project type - Currently supports website applications

### Project Types

#### Website

Creates a basic Huuma website application with the following structure:

```
your-project-name/
├── static/
├── app/
│   ├── page.tsx
│   └── root.tsx
├── src/
├── app.ts
├── dev.ts
└── deno.json
```

- `static/` - Directory for static assets served at the URL root
- `app/` - Directory for page components
- `src/` - Directory for application source code
- `app.ts` - Main application entry point
- `dev.ts` - Development server entry point
- `deno.json` - Deno configuration file

The scaffolder also asks whether to **add Tailwind CSS**. If you opt in, it adds
the Tailwind v4 dependencies (and `"nodeModulesDir": "auto"`) to `deno.json`,
creates `src/styles.css` (`@import "tailwindcss";`), links it from the page head
as `/styles.css`, and wires `await tailwindcss()` into `dev.ts` so styles
compile to `static/styles.css` on every `deno task dev` / `deno task bundle`.

The scaffolder also asks whether to **add a skills bundle from @huuma/ui**. If
you opt in, every valid skill from
[`huuma-studio/ui`](https://github.com/huuma-studio/ui/tree/main/skills)'s
`skills/` directory is installed into the new project's `.agents/skills/`,
atomically — if any member fails validation, none are installed. Each installed
skill becomes a normal entry in the same registry used by `huuma skills add`
(see [Skills](#skills)), so a future `huuma skills update` can re-fetch members
individually. A failed bundle is non-fatal: the project is still created and
`Deno.exitCode` is set to `1` so CI can detect the partial failure.

## Available Scripts

After creating a project, you can use the following commands from your project
directory:

```bash
# Start development server with hot reloading
deno task dev

# Bundle the application for production
deno task bundle

# Start the production server
deno task start
```

## AI Agent

Chat with an AI agent directly in your terminal:

```bash
huuma agent
```

This opens an interactive session — type your message and press Enter
(`Shift+Enter` for a new line). Type `exit` or `quit` to leave. You can also ask
a single question without entering the session:

```bash
huuma agent "What is the capital of France?"
```

Run `huuma agent --help` for a quick reference of the options and environment
variables described below.

### Providers

On first run the agent asks which model provider to use and prompts for whatever
it needs (API key, model). Pass `--model provider/model` to skip the provider
and model prompts:

```bash
HUUMA_AGENT_API_KEY=sk-... \
  huuma agent --model anthropic/claude-haiku-4-5 "Summarize what git is in one line"
```

Supported providers are `anthropic`, `openai`, `google`, `mistral`, and
`ollama`; the model id is whatever the provider accepts
(`anthropic/claude-haiku-4-5`, `openai/gpt-4o-mini`, `google/gemini-2.5-flash`,
`mistral/mistral-small-latest`, `ollama/llama3.2`). For Ollama, `--host` sets
the endpoint (default `http://localhost:11434`); the flag is rejected for other
providers, whose endpoints are fixed. Only the credentials stay environment
variables:

| Variable              | Description                                        |
| --------------------- | -------------------------------------------------- |
| `HUUMA_AGENT_API_KEY` | API key for the provider (omit for a local Ollama) |

### Managed turns (Huuma Studio)

`huuma agent` also supports a **managed turn**: one non-interactive execution of
a resumable Studio conversation. Adding `--callback-url` selects this mode; it
does not change the existing local one-shot or interactive chat behavior.

A managed invocation supplies an atomic group of flags. The history is a native
`@huuma/ai` `Message[]` JSON file which must be non-empty and end in the
**triggering user message**. The runner reads that file before entering `--cwd`,
then passes its final message as the Agent prompt and the preceding messages as
history. Do not pass a positional prompt in this mode.

```bash
HUUMA_AGENT_CALLBACK_SECRET=replace-with-turn-secret \
HUUMA_AGENT_API_KEY=replace-with-provider-key \
  huuma agent \
    --callback-url https://studio.example/runs/123/callback \
    --history /workspace/history.json \
    --cwd /workspace \
    --run-id 11111111-1111-1111-1111-111111111111 \
    --turn-id 22222222-2222-2222-2222-222222222222 \
    --turn-deadline 2026-07-19T12:30:00Z \
    --model anthropic/claude-haiku-4-5
```

All of `--history`, `--cwd`, `--run-id`, `--turn-id`, `--turn-deadline`, and
`--model` are required with `--callback-url`. `HUUMA_AGENT_CALLBACK_SECRET` is
also required and is accepted only from the environment; never place it in argv
or a workspace file. Hosted providers require `HUUMA_AGENT_API_KEY`. An Ollama
managed turn instead requires an explicit `--host` and may omit the provider key
for an unauthenticated host.

Managed mode never reads stdin or opens a REPL. It sends `turn.running`, ordered
`message.appended` events, then exactly one terminal `turn.finished` or
`turn.failed` event to the callback URL. Every callback has a deterministic
idempotency key; transient network, `408`, `429`, and `5xx` responses are
retried. Non-terminal retries stop 15 seconds before `--turn-deadline` so a
terminal failure can be reported; terminal callbacks may retry through the hard
deadline. The CLI exits `0` only after `turn.finished` is acknowledged.

Errors reported through `turn.failed` are sanitized and truncated; callback
secrets and raw provider payloads are never sent or printed. Studio owns retries
of Agent execution: a retry is a new managed turn with a new `--turn-id`, while
HTTP retries within one turn reuse its idempotency keys.

> **Why flags and not env vars?** With `cli` or file tools enabled the agent can
> edit the files that set env vars (a shell rc, a `.env`), silently steering
> which model — or whose server — its future runs talk to. Flags live in process
> argv, which the agent cannot mutate; only secrets stay in the environment. See
> ADR 0007 and 0008.

### Tools

The agent's **skills tools are always on**: `list_skills` and `retrieve_skill`
scan `.agents/skills/` (the directory `huuma skills add` installs into) so the
model can find and follow installed skills. They are a baseline capability —
they do not need to be listed in `--tools`, and `--tools` does not gate them. A
missing skills directory is harmless (the tools report an empty list). Use
`--skills-path <dir>` to point them elsewhere for a run.

Action tools are opt-in per run via the `--tools` flag (a comma-separated list),
so nothing powerful is enabled unless you ask for it on the command line.

```bash
huuma agent --tools read_file,grep "What does src/mod.ts export?"
huuma agent --skills-path ./other-skills "What skills are installed there?"
```

### System prompt

The agent ships a built-in system prompt (concise, plain-text,
terminal-friendly). Override it for a single run with `--system-prompt` — the
supplied text **replaces** the built-in entirely, so the output style is then
yours to manage:

```bash
huuma agent --system-prompt "Be a SQL expert, answer only in SQL." "select all users"
huuma agent --system-prompt="Be terse." "fix the tests"
```

Both the space form and the `--system-prompt=` form are accepted. A missing or
empty value is rejected. The flag must come before the prompt, like `--tools`.

> **Why a flag and not a file/env var?** With file tools enabled the agent can
> rewrite files (and the shell rc that sets env vars), so a file- or env-backed
> system prompt could be poisoned mid-run and persist across sessions. The
> inline flag lives in process argv, which the agent cannot mutate. See
> ADR 0006.

| Tool               | Description                                                  |
| ------------------ | ------------------------------------------------------------ |
| `cli`              | Run allow-listed CLI commands                                |
| `grep`             | Search files for a pattern                                   |
| `read_file`        | Read a file                                                  |
| `write_file`       | Write a file                                                 |
| `create_directory` | Create a directory                                           |
| `delete_file`      | Delete a file or directory                                   |
| `edit_file`        | Make an in-place edit to a file                              |
| `files`            | Shorthand for the five file tools above                      |
| `fetch_website`    | Fetch a URL and return it as Markdown                        |
| `search`           | Search the web                                               |
| `skills`           | `list_skills` + `retrieve_skill`; always enabled (see Tools) |

A few tools need extra configuration, supplied through flags; only the search
API keys are environment variables:

| Flag / variable                        | Tool     | Description                                                           |
| -------------------------------------- | -------- | --------------------------------------------------------------------- |
| `--cli-commands <list>`                | `cli`    | Comma-separated allow-list of commands the agent may run (`deno,git`) |
| `--search-engine <engine>`             | `search` | `brave` or `perplexity`                                               |
| `--skills-path <dir>`                  | `skills` | Directory the always-on skills tools scan (default `.agents/skills`)  |
| `BRAVE_API_KEY` / `PERPLEXITY_API_KEY` | `search` | API key for the chosen search engine                                  |

```bash
# A read-only research agent
huuma agent --tools read_file,grep,fetch_website "Find where Registry is defined"

# A coding agent allowed to run Deno and Git
huuma agent --tools files,cli --cli-commands deno,git \
  "Run the tests and fix any failures"
```

> **Heads up:** the `cli` tool runs real commands. Keep `--cli-commands` as
> narrow as possible — anything that can spawn other programs (a shell, `env`,
> or an interpreter such as `deno`/`node`/`python`) effectively grants arbitrary
> command execution.

### Sub-agents

The `--tools` list also accepts preset sub-agents — self-contained helpers the
agent can delegate a task to. A sub-agent runs its own loop with its own tools
on the same provider and model, and only its findings return to the
conversation. The agent decides when to delegate; each delegation prints a dim
status line so you can see it happening.

| Sub-agent  | Description                                         |
| ---------- | --------------------------------------------------- |
| `explorer` | Read-only investigation with `read_file` and `grep` |

```bash
huuma agent --tools explorer "How does src/skills/update.ts handle conflicts?"
```

## Skills

Skills are directories conforming to the
[Agent Skills specification](https://agentskills.io/specification): a `SKILL.md`
file with required `name` and `description` YAML frontmatter, plus optional
`scripts/`, `references/`, and `assets/` directories. A skill extends an AI
agent's behavior. Within a Huuma project, a skill lives under
`.agents/skills/<name>/`.

Install a skill from a public GitHub repository with `huuma skills add`:

```bash
huuma skills add --path=https://github.com/anthropics/skills/tree/main/skills/mcp-builder
```

The `--path` URL must follow this grammar:

```
https://github.com/<owner>/<repo>/tree/<ref>[/<subpath>]
```

- `<owner>`, `<repo>`: non-empty, no `/`.
- `<ref>`: a single path segment (no `/`). Branch names containing slashes (e.g.
  `feature/foo`) cannot be represented — pin a tag or a top-level branch
  instead.
- `<subpath>`: zero or more segments; the skill directory is `<subpath>`
  resolved against the repo root, or the repo root when absent.

Examples:

```
https://github.com/anthropics/skills/tree/main/skills/mcp-builder
https://github.com/mattpocock/skills/tree/main/skills/engineering/codebase-design
```

Notes:

- Public repositories only in v1; private-repo auth is not supported.
- Skills install into `<cwd>/.agents/skills/`, with a content-hash manifest at
  `.agents/skills/.manifest.json` recording each install's source and hash.
- Re-adding a skill from the same `owner/repo` overwrites (the ref may differ).
  Re-adding a same-named skill from a _different_ `owner/repo` is refused unless
  you pass `--force`, which also discards any local edits you've made to an
  installed skill.

Run `huuma skills --help` and `huuma skills add --help` for the quick reference.

### Updating skills

Re-fetch tracked skills from the GitHub ref recorded at install time and update
the on-disk copy when upstream has moved:

```bash
huuma skills update
huuma skills update mcp-builder --force
```

With no names, `update` re-fetches every tracked skill (those with an entry in
`.agents/skills/.manifest.json`). Untracked skills are skipped — `update` is
manifest-driven and never enumerates the filesystem. Skills are processed
sequentially in sorted-by-name order, one at a time, best-effort: a failure on
one skill prints a `✖` line and sets `Deno.exitCode = 1` but does not abort the
others. The manifest is rewritten once at the end with the entries of every
successfully swapped skill folded in; a run where nothing moved writes nothing.

Per-skill outcomes:

- `✓ <name> is up to date` — re-fetched content hash equals the recorded hash;
  no swap, no manifest change.
- `✓ <name> updated` — upstream moved, validation passed, swapped in.
- `✖ <name>: skill has local edits; re-run with --force to discard them` — the
  on-disk content differs from the manifest and upstream has moved. Refused
  without `--force`.
- `✖ <name>: ...` — fetch failure, upstream validation regression, upstream
  rename, missing on disk, or an untracked name passed on the CLI.

`--force` lifts the locally-edited guard for every selected skill. It also
re-syncs an already-current-but-locally-edited skill back to the canonical
upstream hash (since `--force` means "discard edits"). A run exits `0` iff no
skill was refused or failed; otherwise it exits `1`.

Run `huuma skills update --help` for the quick reference.

## Requirements

- [Deno](https://deno.com/) runtime

## License

MIT

---

Built with ❤️ by the Huuma team
