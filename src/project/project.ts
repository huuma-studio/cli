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
  const projectName = await ask("Project name:");

  await createDir(projectName);
  await type(projectName);

  return "";
};

async function ask(q: string): Promise<string> {
  const projectName = await question(q);
  if (!projectName) {
    return ask(q);
  }
  return projectName;
}

async function type(projectName: string) {
  console.log("\nSelect the type of application to initialize:");
  const input = await choose(registry.all().map((cmd) => cmd.names[0]));
  const type = registry.all().find((type) => {
    return type.names[0] === input;
  });
  type?.command(projectName);
}
