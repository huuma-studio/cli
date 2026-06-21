# Implementation Plan — Tailwind option for `huuma project website`

> Sequences the build for an opt-in Tailwind CSS setup in the `website`
> scaffold. It does not re-justify the framework's CSS pipeline — it wires the
> existing `@huuma/theme/tailwind` helper into the generated project.

## Goal

When scaffolding a `website` project, optionally wire up Tailwind CSS v4 so the
new project ships with a working CSS pipeline: deps in `deno.json`, a
`src/styles.css` entry, a `<link href="/styles.css">` in the page head, and a
`dev.ts` that compiles styles on each run.

## Decisions

- **Compile helper**: `@huuma/theme/tailwind` exports
  `async function tailwindcss(options?)`, which runs
  `deno run -A npm:@tailwindcss/cli -i src/styles.css -o static/styles.css`
  (defaults: `inputPath="src/styles.css"`, `outputPath="static/styles.css"`). No
  new local helper code — the generated `dev.ts` just imports it.
- **Why it fits**: the `website` scaffold already creates `static/`, and
  `app/root.tsx` calls `loadStaticFiles(app)` (`@huuma/route`), which serves
  `static/` at the URL root — so `static/styles.css` is reachable at
  `/styles.css`.
- **Deps added (Tailwind opt-in only)**: `@huuma/theme` (jsr, for the helper),
  `tailwindcss` (`npm:tailwindcss@^4`, so `@import "tailwindcss"` resolves),
  `@tailwindcss/cli` (`npm:@tailwindcss/cli@^4`), plus top-level
  `"nodeModulesDir": "auto"` so the CLI can resolve `tailwindcss` from a
  materialized `node_modules`.
- **First-boot placeholder**: `loadStaticFiles` enumerates `static/` **at
  startup** (in `app/root.tsx`, imported before `dev.ts`'s body runs
  `await tailwindcss()`). On a brand-new project `static/styles.css` would not
  exist yet, so the `/styles.css` route would not register until a restart.
  Scaffolding a placeholder `static/styles.css` makes the route register on
  first boot; the per-request handler reads the file fresh, so compiled content
  is served once the helper overwrites it.
- **How surfaced**: a `confirm("Add Tailwind CSS?")` prompt, matching the
  existing `.zed` / `.vscode` confirm prompts.

## File map (new + modified)

```
cli/
├── README.md                          [modify] note Tailwind prompt; add styles.css to structure
├── docs/feat/add-tailwind/PLAN.md     [new] this plan
└── src/project/types/website.ts       [modify] all scaffold logic (below)
```

All code changes live in `src/project/types/website.ts`. A `tailwind: boolean`
(from the new prompt) threads through the helpers that change:

- **`denoConfigContent(tailwind)`** — was a module-level template const; now a
  function. When `tailwind`, interpolates the three extra imports and the
  `nodeModulesDir` key. No `tasks` changes — `dev`/`bundle` already pass
  `--allow-run` (the helper spawns `deno run`) and `-ERWN` covers
  read/write/net.
- **`rootTsContent(tailwind)`** — injects
  `<link rel="stylesheet" href="/styles.css" />` into `<head>`.
- **`devTsContent(tailwind)`** — prepends
  `import { tailwindcss } from "@huuma/theme/tailwind";` and calls
  `await tailwindcss();` as the first body statement. `app.ts` (production
  `start`) is unchanged — production styles come from `deno task bundle`, which
  runs `dev.ts --bundle`.
- **`tailwindStyles(projectName)`** — new; writes `src/styles.css`
  (`@import "tailwindcss";`) and the `static/styles.css` placeholder, gated on
  the flag in the default export.

## Reused building blocks

- `confirm(...)` — `src/input.ts` (already used for `.zed`/`.vscode`).
- `createFile` / `createDir` — `src/project/file.ts`,
  `src/project/directory.ts`.
- `latest(module)` — `src/project/version.ts` (newest JSR version + fallback;
  used for `@huuma/theme`).

## Verification

Scaffold non-interactively (prompts read stdin; not a TTY when piped):

```bash
cd "$(mktemp -d)"
# answers: project name, choose "website", .zed? .vscode? tailwind?
printf 'demo\nwebsite\nn\nn\ny\n' | deno run -A /path/to/@huuma/cli/src/mod.ts project

cd demo
cat deno.json          # @huuma/theme, tailwindcss, @tailwindcss/cli, "nodeModulesDir":"auto"
cat src/styles.css     # @import "tailwindcss";
cat static/styles.css  # placeholder comment
grep styles.css app/root.tsx   # <link rel="stylesheet" href="/styles.css" />
grep tailwindcss dev.ts        # import + await tailwindcss()

deno check dev.ts app.ts app/root.tsx   # types resolve
deno task dev                           # compiles static/styles.css; GET /styles.css → 200
```

Non-Tailwind path (answer `n`): `deno.json` has no tailwind deps /
`nodeModulesDir`, and no `src/styles.css` / `static/styles.css` are created.

Existing tests (`src/project/project_test.ts`, `--help` only) stay green;
`deno task test` should still pass.
