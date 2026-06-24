/**
 * Parent `skills` command — mirrors `src/project/project.ts`. Owns a
 * `Registry` of sub-commands; `add` is registered first. Later: `list`,
 * `update`, `remove`.
 */
import { isHelpFlag, Registry } from "../command.ts";
import { red } from "../terminal.ts";
import add from "./add.ts";
import update from "./update.ts";

const registry = new Registry();

registry.add({
  names: ["add"],
  description: "Install a skill from a public GitHub repository",
  command: add,
});

registry.add({
  names: ["update"],
  description: "Re-fetch tracked skills from their recorded GitHub ref",
  command: update,
});

export default async (args: string[] = []): Promise<string> => {
  // Only short-circuit to skills help when help is the first arg (or no args);
  // `skills add --help` must delegate to `add`'s own help.
  if (args.length === 0 || isHelpFlag(args[0])) {
    return skillsHelp();
  }

  const [sub, ...rest] = args;

  const command = registry.find(sub);
  if (!command) {
    console.error(red(`✖ Unknown skills sub-command: '${sub}'`));
    console.error(skillsHelp());
    Deno.exitCode = 1;
    return "";
  }
  return await command.command(rest);
};

/** Usage text shown for `huuma skills --help` / `huuma skills`. Lists the
 * registered sub-commands, derived from the registry so it stays in sync. */
export function skillsHelp(): string {
  const subs = registry.all()
    .map((cmd) => `  ${cmd.names[0].padEnd(10)}${cmd.description}`)
    .join("\n");
  return `Manage skills for your project.

USAGE
  huuma skills <sub-command> [OPTIONS]

Installs skills from public GitHub repositories into .agents/skills/ so an AI
agent can use them. Skills follow the Agent Skills specification.

SUB-COMMANDS
${subs}`;
}
