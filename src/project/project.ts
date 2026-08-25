import { parseArgs } from "@std/cli/parse-args";
import { isHelpFlag, Registry } from "../command.ts";
import { create as createDir } from "./directory.ts";
import { choose, question } from "../input.ts";
import { red } from "../terminal.ts";
import website, { type WebsiteOptions } from "./types/website.ts";

const registry = new Registry();

registry.add({
  names: ["website"],
  description: "Application structure suitable for websites",
  command: website,
});

// Boolean flag pairs: positive → negative. Used for contradictory-flag
// detection and WebsiteOptions resolution.
const flagPairs = [
  ["zed", "no-zed"],
  ["vscode", "no-vscode"],
  ["tailwind", "no-tailwind"],
  ["skills", "no-skills"],
] as const;

export default async (args: string[] = []) => {
  if (args.some(isHelpFlag)) return projectHelp();

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(args, {
      string: ["type"],
      boolean: flagPairs.flat(),
      unknown: (arg: string) => {
        // Allow positional arguments (project name); only reject unknown
        // options (anything starting with `-`).
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
      },
    });
  } catch (cause) {
    console.error(red(`✖ ${(cause as Error).message}`));
    console.error(projectHelp());
    Deno.exitCode = 1;
    return "";
  }

  const [projectName] = parsed._.map(String);

  // Reject contradictory flag pairs (e.g. --zed --no-zed).
  for (const [pos, neg] of flagPairs) {
    if (parsed[pos] && parsed[neg]) {
      console.error(
        red(`✖ Contradictory flags: --${pos} and --${neg}`),
      );
      Deno.exitCode = 1;
      return "";
    }
  }

  // Non-terminal context: required options must be supplied via flags.
  if (!Deno.stdin.isTerminal()) {
    if (!projectName) {
      console.error(red("✖ Missing required argument: <name>"));
      console.error(projectHelp());
      Deno.exitCode = 1;
      return "";
    }
    if (!parsed.type) {
      console.error(red("✖ Missing required option: --type <type>"));
      console.error(projectHelp());
      Deno.exitCode = 1;
      return "";
    }
  }

  // Validate --type before creating any directories, so an invalid type
  // doesn't leave an empty project directory on disk.
  if (parsed.type) {
    const cmd = registry.find(parsed.type);
    if (!cmd) {
      const validTypes = registry.all().map((c) => c.names[0]).join(", ");
      console.error(
        red(`✖ Invalid type '${parsed.type}'. Valid types: ${validTypes}`),
      );
      Deno.exitCode = 1;
      return "";
    }
  }

  // Project name: use flag value or fall back to interactive prompt.
  let name = projectName;
  if (!name) {
    name = await question("Project name:", {
      validate: (value) => value ? undefined : "Project name is required",
    });
  }

  await createDir(name);
  return await type(name, parsed.type, parsed);
};

/** Usage text shown for `huuma project --help`. Types are derived from the
 * registry so the list stays in sync with what `project` can scaffold. */
function projectHelp(): string {
  const types = registry.all()
    .map((cmd) => `  ${cmd.names[0].padEnd(10)}${cmd.description}`)
    .join("\n");
  return `Scaffold a new Huuma application.

USAGE
  huuma project <name> [OPTIONS]

  Creates the project directory and files. When all options are supplied
  via flags the command runs non-interactively.

ARGUMENTS
  <name>   Project name (used as the directory name)

OPTIONS
  --type <type>      Project type to scaffold (see TYPES below)
  --zed              Include .zed/settings.json
  --no-zed           Skip .zed/settings.json
  --vscode           Include .vscode/settings.json
  --no-vscode        Skip .vscode/settings.json
  --tailwind         Include Tailwind CSS setup
  --no-tailwind      Skip Tailwind CSS setup
  --skills           Install the @huuma/ui skills bundle
  --no-skills        Skip the skills bundle
  -h, --help         Show this help

TYPES
${types}`;
}

async function type(
  projectName: string,
  typeFlag: string | undefined,
  parsed: ReturnType<typeof parseArgs>,
) {
  let typeName: string;

  if (typeFlag) {
    // Already validated before directory creation — safe to trust.
    typeName = registry.find(typeFlag)!.names[0];
  } else {
    // Fall back to interactive selection.
    const input = await choose(
      registry.all().map((cmd) => ({
        label: cmd.names[0],
        description: cmd.description,
      })),
      "Select the type of application to initialize:",
    );
    typeName = input;
  }

  const cmd = registry.find(typeName)!;

  // Build WebsiteOptions from parsed boolean flags. Map both the positive
  // (`--zed` → true) and negative (`--no-zed` → false) variants. Only pass
  // through flags that were explicitly set so the type command knows whether
  // to use the value or fall back to its own prompt.
  const options: WebsiteOptions = {};
  for (const [pos, neg] of flagPairs) {
    if (parsed[neg]) (options as Record<string, boolean>)[pos] = false;
    else if (parsed[pos]) (options as Record<string, boolean>)[pos] = true;
  }

  return await cmd.command(projectName, options);
}