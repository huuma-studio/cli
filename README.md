# Huuma CLI

[![JSR Score](https://jsr.io/badges/@huuma/cli/score)](https://jsr.io/@huuma/cli) [![JSR Version](https://jsr.io/badges/@huuma/cli)](https://jsr.io/@huuma/cli)

Huuma CLI is a command-line tool for creating and managing Huuma applications. It provides utility commands to streamline Huuma application development.

> **Note**: Huuma CLI is currently in early development. Options and commands might change in future versions. Use with caution!

## Installation

```bash
deno install -A -f -g -r -n huuma jsr:@huuma/cli
```

## Usage

```
huuma [OPTIONS] [COMMAND]
```

### Options

| Option | Description |
|--------|-------------|
| `-h, --help` | Display help information |
| `-V, --version` | Show current version of Huuma CLI |

### Commands

| Command | Description |
|---------|-------------|
| `p, project` | Create a new project structure |
| `u, upgrade` | Upgrade Huuma CLI to the latest version |


## Creating a New Project

You can create a new Huuma project with the following command:

```bash
huuma project
```

The CLI will prompt you for:
1. Project name - The name of your new project (will be created as a directory)
2. Project type - Currently supports website applications

### Project Types

#### Website

Creates a basic Huuma website application with the following structure:

```
your-project-name/
├── assets/
├── pages/
│   ├── page.tsx
│   └── root.tsx
├── src/
├── app.ts
├── dev.ts
└── deno.json
```

- `assets/` - Directory for static assets
- `pages/` - Directory for page components
- `src/` - Directory for application source code
- `app.ts` - Main application entry point
- `dev.ts` - Development server entry point
- `deno.json` - Deno configuration file

## Available Scripts

After creating a project, you can use the following commands from your project directory:

```bash
# Start development server with hot reloading
deno task dev

# Bundle the application for production
deno task bundle

# Start the production server
deno task start
```

## Requirements

- [Deno](https://deno.com/) runtime

## License

MIT

---

Built with ❤️ by the Huuma team
