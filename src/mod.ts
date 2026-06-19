import { type Command, Registry } from "./command.ts";
import config from "../deno.json" with { type: "json" };

import agent from "./agent/agent.ts";
import project from "./project/project.ts";
import skills from "./skills/skills.ts";
import upgrade from "./upgrade/upgrade.ts";

const [cmd, ...args] = Deno.args;

const HUUMA_CLI_VERSION = config.version;

const registry = new Registry();

const defaultArguments: Command[] = [{
  names: ["u", "upgrade"],
  description: `Upgrade "Huuma CLI" to the lastest version`,
  command: upgrade,
}, {
  names: ["-V", "--version"],
  description: 'Show current version of "Huuma CLI"',
  command: () => `Huuma CLI ${HUUMA_CLI_VERSION}`,
}, {
  names: ["-h", "--help"],
  description: "Show help",
  command: help,
}];

const defaultCommands: Command[] = [{
  names: ["p", "project"],
  description: "Create a new project structure",
  command: project,
}, {
  names: ["a", "agent"],
  description: "Chat with an AI agent in your terminal",
  command: agent,
}, {
  names: ["s", "skills"],
  description: "Manage skills for your project",
  command: skills,
}];

loadCommands();

const command = registry.find(cmd);

if (typeof command?.command === "function") {
  const result = await command.command(args);
  console.log(result);
} else {
  console.error(`
Error: "${cmd || "no arguments"}" is not a valid command.
${help()}`);
}

function help() {
  return `!---
! "Huuma CLI" is not production ready.
! OPTIONS and COMMANDS might change in a future version.
! Use it with caution!
!---

"Huuma CLI" is a CLI to manage your "Huuma" applications

USAGE:
  huuma [OPTIONS] [COMMAND]

OPTIONS
  -h, --help
  -V, --version

COMMANDS
${
    registry.all().map((command) => {
      return `  ${
        expand(command.names.join(", "), 20)
      } <— ${command.description}\n`;
    }).join("")
  }`;
}

function expand(value: string, length: number) {
  const chars = [...value];
  const difference = length - chars.length - 1;

  for (let i = 0; i < difference; i++) {
    chars.push(" ");
  }

  return chars.join("");
}

function loadCommands() {
  [...defaultCommands, ...defaultArguments].forEach((command) => {
    registry.add(command);
  });
}
