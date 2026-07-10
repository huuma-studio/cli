const MINIMUM_DEPENDENCY_AGE_FLAG_SINCE = [2, 8, 0];

export default async function (): Promise<string> {
  await install();
  return 'Upgrade of "Huuma CLI" successful';
}

async function install(): Promise<void> {
  const args = ["install", "-A", "-f", "-g", "-r"];
  if (supportsMinimumDependencyAgeFlag(Deno.version.deno)) {
    args.push("--minimum-dependency-age", "0");
  }
  args.push("-n", "huuma", "jsr:@huuma/cli");

  const cmd = new Deno.Command("deno", {
    stdout: "inherit",
    args,
  });

  try {
    const res = await cmd.output();
    if (res.success) {
      return;
    }
    console.error(new TextDecoder().decode(res.stderr));
    throw new Error('Error during installation of "Huuma CLI"');
  } catch (e) {
    throw e;
  }
}

export function supportsMinimumDependencyAgeFlag(version: string): boolean {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length < 3 || parts.some(Number.isNaN)) {
    return false;
  }
  for (let i = 0; i < 3; i++) {
    if (parts[i] > MINIMUM_DEPENDENCY_AGE_FLAG_SINCE[i]) {
      return true;
    }
    if (parts[i] < MINIMUM_DEPENDENCY_AGE_FLAG_SINCE[i]) {
      return false;
    }
  }
  return true;
}
