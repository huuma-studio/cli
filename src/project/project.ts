import { isHelpFlag, Registry } from "../command.ts";
import { create as createDir } from "./directory.ts";
import { choose, question } from "../input.ts";

import website from "./types/website.ts";

const registry = new Registry();

registry.add({
  names: ["website"],
  description: "Application structure suitable for websites",
  command: website,
});

export default async (args: string[] = []) => {
  if (args.some(isHelpFlag)) return projectHelp();

  const projectName = await question("Project name:", {
    validate: (value) => value ? undefined : "Project name is required",
  });

  await createDir(projectName);
  await type(projectName);

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
  huuma project [OPTIONS]

  Prompts for a project name and an application type, then creates the
  project directory and files.

OPTIONS
  -h, --help   Show this help

TYPES
${types}`;
}

async function type(projectName: string) {
  const input = await choose(
    registry.all().map((cmd) => ({
      label: cmd.names[0],
      description: cmd.description,
    })),
    "Select the type of application to initialize:",
  );
  const type = registry.all().find((type) => {
    return type.names[0] === input;
  });
  await type?.command(projectName);
}
