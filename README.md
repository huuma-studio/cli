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
it needs (API key, model). Set environment variables to skip the prompts:

| Variable               | Description                                                   |
| ---------------------- | ------------------------------------------------------------- |
| `HUUMA_AGENT_PROVIDER` | `anthropic`, `openai`, or `ollama`                            |
| `HUUMA_AGENT_MODEL`    | Model id (e.g. `claude-haiku-4-5`, `gpt-4o-mini`, `llama3.2`) |
| `HUUMA_AGENT_API_KEY`  | API key for the provider (omit for a local Ollama)            |
| `HUUMA_AGENT_HOST`     | Ollama host (default `http://localhost:11434`)                |

```bash
HUUMA_AGENT_PROVIDER=anthropic HUUMA_AGENT_API_KEY=sk-... \
  huuma agent "Summarize what git is in one line"
```

### Tools

By default the agent only chats. Give it tools with the `--tools` flag — a
comma-separated list. Tools are opt-in per run, so nothing powerful is enabled
unless you ask for it on the command line.

```bash
huuma agent --tools read_file,grep "What does src/mod.ts export?"
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

| Tool               | Description                             |
| ------------------ | --------------------------------------- |
| `cli`              | Run allow-listed CLI commands           |
| `grep`             | Search files for a pattern              |
| `read_file`        | Read a file                             |
| `write_file`       | Write a file                            |
| `create_directory` | Create a directory                      |
| `delete_file`      | Delete a file or directory              |
| `edit_file`        | Make an in-place edit to a file         |
| `files`            | Shorthand for the five file tools above |
| `fetch_website`    | Fetch a URL and return it as Markdown   |
| `search`           | Search the web                          |

A few tools need extra configuration, supplied through environment variables
(the tool stays inert unless you also select it with `--tools`):

| Variable                               | Tool     | Description                                                           |
| -------------------------------------- | -------- | --------------------------------------------------------------------- |
| `HUUMA_AGENT_CLI_COMMANDS`             | `cli`    | Comma-separated allow-list of commands the agent may run (`deno,git`) |
| `HUUMA_AGENT_SEARCH_ENGINE`            | `search` | `brave` or `perplexity`                                               |
| `BRAVE_API_KEY` / `PERPLEXITY_API_KEY` | `search` | API key for the chosen search engine                                  |

```bash
# A read-only research agent
huuma agent --tools read_file,grep,fetch_website "Find where Registry is defined"

# A coding agent allowed to run Deno and Git
HUUMA_AGENT_CLI_COMMANDS=deno,git \
  huuma agent --tools files,cli "Run the tests and fix any failures"
```

> **Heads up:** the `cli` tool runs real commands. Keep
> `HUUMA_AGENT_CLI_COMMANDS` as narrow as possible — anything that can spawn
> other programs (a shell, `env`, or an interpreter such as `deno`/`node`/
> `python`) effectively grants arbitrary command execution.

### Sub-agents

The `--tools` list also accepts preset sub-agents — self-contained helpers
the agent can delegate a task to. A sub-agent runs its own loop with its own
tools on the same provider and model, and only its findings return to the
conversation. The agent decides when to delegate; each delegation prints a
dim status line so you can see it happening.

| Sub-agent  | Description                                                    |
| ---------- | -------------------------------------------------------------- |
| `explorer` | Read-only investigation with `read_file` and `grep`            |

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
- `<ref>`: a single path segment (no `/`). Branch names containing slashes
  (e.g. `feature/foo`) cannot be represented — pin a tag or a top-level branch
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

Run `huuma skills --help` and `huuma skills add --help` for the quick
reference.

### Updating skills

Re-fetch tracked skills from the GitHub ref recorded at install time and
update the on-disk copy when upstream has moved:

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
