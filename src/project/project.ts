import { Registry } from "../command.ts";
import { create as createDir } from "./directory.ts";
import { choose, question } from "../input.ts";

import website from "./types/website.ts";

const registry = new Registry();

registry.add({
  names: ["website"],
  description: "Application structure suitable for websites",
  command: website,
});

export default async () => {
  const projectName = await question("Project name:", {
    validate: (value) => value ? undefined : "Project name is required",
  });

  await createDir(projectName);
  await type(projectName);

  return "";
};

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
