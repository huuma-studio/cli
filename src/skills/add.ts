/**
 * `huuma skills add` subcommand.
 *
 * Arg parsing via `@std/cli` `parseArgs`. Exports `runAdd(args, deps?)` where
 * `deps.fetch` threads to `installSkill`'s test seam; the default export calls
 * `runAdd(args)` with no deps so the `Command` signature is unchanged.
 *
 * Output style: `dim(…)` progress (delegated to `installSkill`), `green(✓)`
 * success, `yellow` warnings, `red(✖)` errors with `Deno.exitCode = 1`.
 */
import { parseArgs } from "@std/cli/parse-args";
import { green, red, yellow } from "../terminal.ts";
import { isHelpFlag } from "../command.ts";
import {
  formatSource,
  type ParsedPath,
  parsePath,
  PathParseError,
} from "./path.ts";
import { installSkill } from "./install.ts";

export interface AddDeps {
  /** Test seam threaded into `installSkill.fetch`. */
  fetch?: (url: string) => Promise<ReadableStream<Uint8Array>>;
  /** Output sink for progress/success lines (default `console.log`). */
  log?: (line: string) => void;
  /** Error sink (default `console.error`). */
  err?: (line: string) => void;
}

/** Parse and run `huuma skills add`. Returns the success-summary string (or
 * `""` after printing an error and setting `Deno.exitCode = 1`). */
export async function runAdd(
  args: string[],
  deps: AddDeps = {},
): Promise<string> {
  const log = deps.log ?? console.log;
  const err = deps.err ?? console.error;

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(args, {
      string: ["path"],
      boolean: ["force", "help"],
      alias: { help: "h" },
      default: { force: false, help: false },
      unknown: (arg: string) => {
        throw new Error(`Unknown option: ${arg}`);
      },
    });
  } catch (cause) {
    err(red(`✖ ${(cause as Error).message}`));
    err(addHelp());
    Deno.exitCode = 1;
    return "";
  }

  if (parsed.help || args.some(isHelpFlag)) {
    return addHelp();
  }

  if (typeof parsed.path !== "string" || parsed.path.length === 0) {
    err(red("✖ Missing required option: --path <github-url>"));
    err(addHelp());
    Deno.exitCode = 1;
    return "";
  }

  let path: ParsedPath;
  try {
    path = parsePath(parsed.path);
  } catch (cause) {
    if (cause instanceof PathParseError) {
      err(red(`✖ ${cause.message}`));
      Deno.exitCode = 1;
      return "";
    }
    throw cause;
  }

  try {
    const result = await installSkill({
      parsed: path,
      force: parsed.force,
      cwd: Deno.cwd(),
      fetch: deps.fetch,
      log,
    });

    const summary = `Installed skill '${result.name}' from ${
      formatSource(path)
    } to ${result.target}`;
    log(green("✓") + " " + summary);
    for (const warning of result.warnings) {
      log(yellow("  ⚠ " + warning));
    }
    return "";
  } catch (cause) {
    const message = (cause as Error)?.message ?? String(cause);
    err(red(`✖ ${message}`));
    Deno.exitCode = 1;
    return "";
  }
}

/** Default export: run `add` with the real `downloadTarball`. */
export default (args: string[] = []) => runAdd(args);

/** Usage text for `huuma skills add --help`, mirroring `project --help`. */
export function addHelp(): string {
  return `Install a skill from a public GitHub repository.

USAGE
  huuma skills add --path=<github-url> [--force]

OPTIONS
  --path <url>   GitHub tree URL: https://github.com/<owner>/<repo>/tree/<ref>[/<subpath>]
  --force        Overwrite an installed same-named skill from a different
                 source, or discard local edits to an installed skill.
  -h, --help     Show this help

EXAMPLE
  huuma skills add \\
    --path=https://github.com/anthropics/skills/tree/main/skills/mcp-builder`;
}
