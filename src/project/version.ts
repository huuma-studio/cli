import type { Command } from "../command.ts";

const latest = new Map<string, string>();

export const version: Command["command"] = async function (
  module: string,
  fallback: string,
): Promise<string> {
  if (!latest.get(module)) {
    try {
      latest.set(
        module,
        await fetch(`https://deno.land/x/${module}`).then((response) => {
          const version = response.url.split("@")[1];
          return version || fallback;
        }),
      );
    } catch (_e) {
      latest.set(module, fallback);
    }
  }

  return <string> latest.get(module);
};
