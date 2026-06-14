export interface Command {
  names: string[];
  description: string;
  // deno-lint-ignore no-explicit-any
  command: (...args: any[]) => string | Promise<string>;
}

/** True when `arg` is a help flag (`--help` or `-h`) — the shared request to
 * print a command's usage instead of running it. */
export function isHelpFlag(arg: string): boolean {
  return arg === "--help" || arg === "-h";
}

export class Registry {
  private commands: Command[] = [];

  static isCommandId(name: string, command: Command): boolean {
    return !!command.names.find((cmd_name) => {
      return cmd_name === name;
    });
  }

  add(command: Command): void {
    this.commands.push(command);
  }

  find(name: string): Command | undefined {
    return this.commands.find((command) => Registry.isCommandId(name, command));
  }

  all(): Command[] {
    return [...this.commands];
  }
}
