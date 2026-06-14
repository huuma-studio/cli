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
├── assets/
├── app/
│   ├── page.tsx
│   └── root.tsx
├── src/
├── app.ts
├── dev.ts
└── deno.json
```

- `assets/` - Directory for static assets
- `app/` - Directory for page components
- `src/` - Directory for application source code
- `app.ts` - Main application entry point
- `dev.ts` - Development server entry point
- `deno.json` - Deno configuration file

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

## Requirements

- [Deno](https://deno.com/) runtime

## License

MIT

---

Built with ❤️ by the Huuma team
