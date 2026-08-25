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

export default async (args: string[] = []) => {
  if (args.some(isHelpFlag)) return projectHelp();

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(args, {
      string: ["type"],
      boolean: ["zed", "vscode", "tailwind", "skills"],
      unknown: (arg: string) => {
        throw new Error(`Unknown option: ${arg}`);
      },
    });
  } catch (cause) {
    console.error(red(`✖ ${(cause as Error).message}`));
    console.error(projectHelp());
    Deno.exitCode = 1;
    return "";
  }

  const [projectName] = parsed._.map(String);

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

  // Project name: use flag value or fall back to interactive prompt.
  let name = projectName;
  if (!name) {
    name = await question("Project name:", {
      validate: (value) => value ? undefined : "Project name is required",
    });
  }

  await createDir(name);
  await type(name, parsed.type, parsed);
  return "";
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
    const cmd = registry.find(typeFlag);
    if (!cmd) {
      const validTypes = registry.all().map((c) => c.names[0]).join(", ");
      const message =
        `Invalid type '${typeFlag}'. Valid types: ${validTypes}`;
      if (!Deno.stdin.isTerminal()) {
        console.error(red(`✖ ${message}`));
        Deno.exitCode = 1;
        return "";
      }
      throw new Error(message);
    }
    typeName = cmd.names[0];
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

  // Build WebsiteOptions from parsed boolean flags. Only pass through flags
  // that were explicitly set (boolean, not undefined) so the type command
  // knows whether to use the value or fall back to its own prompt.
  const options: WebsiteOptions = {};
  if (typeof parsed.zed === "boolean") options.zed = parsed.zed;
  if (typeof parsed.vscode === "boolean") options.vscode = parsed.vscode;
  if (typeof parsed.tailwind === "boolean") options.tailwind = parsed.tailwind;
  if (typeof parsed.skills === "boolean") options.skills = parsed.skills;

  await cmd.command(projectName, options);
}