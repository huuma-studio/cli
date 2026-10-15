import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import projectCommand from "./project.ts";

const fetchMetadata: typeof fetch = (input) =>
  Promise.resolve(Response.json(
    String(input).includes("/ui/")
      ? { latest: "0.2.11", versions: { "0.3.0-beta.1": { yanked: false } } }
      : { latest: "0.3.1" },
  ));
const project = (args: string[]) =>
  projectCommand(args, { fetch: fetchMetadata });

// --help must short-circuit before the interactive prompts, so these run
// without any stdin or file-system access.
Deno.test("project --help returns usage without prompting", async () => {
  const result = await project(["--help"]);
  assertStringIncludes(result, "huuma project <name> [OPTIONS]");
  assertStringIncludes(result, "website"); // a registered project type
  assertStringIncludes(result, "--type");
  assertStringIncludes(result, "--tailwind");
  assertStringIncludes(result, "--no-skills");
  assertStringIncludes(result, "--package-manager");
  assertStringIncludes(result, "--install");
  assertEquals(result.includes("--zed"), false);
  assertEquals(result.includes("--vscode"), false);
});

Deno.test("project -h returns the same usage", async () => {
  assertStringIncludes(await project(["-h"]), "huuma project <name> [OPTIONS]");
});

// Non-terminal error cases. In the test runner stdin is not a terminal, so
// the command's non-terminal validation paths are exercised directly.
Deno.test("missing project name in non-terminal context returns error", async () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (msg: string) => errors.push(String(msg));
  Deno.exitCode = 0;
  try {
    const result = await project(["--type=website"]);
    assertEquals(result, "");
    assert(Deno.exitCode === 1);
    assertStringIncludes(errors.join("\n"), "Missing required argument");
    assertStringIncludes(errors.join("\n"), "<name>");
  } finally {
    console.error = originalError;
    Deno.exitCode = 0;
  }
});

Deno.test("missing --type in non-terminal context returns error", async () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (msg: string) => errors.push(String(msg));
  Deno.exitCode = 0;
  try {
    const result = await project(["my-app"]);
    assertEquals(result, "");
    assert(Deno.exitCode === 1);
    assertStringIncludes(errors.join("\n"), "Missing required option");
    assertStringIncludes(errors.join("\n"), "--type");
  } finally {
    console.error = originalError;
    Deno.exitCode = 0;
  }
});

Deno.test("invalid --type value returns error listing valid types", async () => {
  const tmpDir = await Deno.makeTempDir();
  const originalCwd = Deno.cwd();
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (msg: string) => errors.push(String(msg));
  Deno.exitCode = 0;
  try {
    Deno.chdir(tmpDir);
    const result = await project(["my-app", "--type=invalid"]);
    assertEquals(result, "");
    assert(Deno.exitCode === 1);
    assertStringIncludes(errors.join("\n"), "Invalid type");
    assertStringIncludes(errors.join("\n"), "website");

    // No project directory should be left on disk after an invalid type.
    assert(!await dirExists(join(tmpDir, "my-app")));
  } finally {
    console.error = originalError;
    Deno.exitCode = 0;
    Deno.chdir(originalCwd);
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("contradictory flags produce an error", async () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (msg: string) => errors.push(String(msg));
  Deno.exitCode = 0;
  try {
    const result = await project([
      "my-app",
      "--type=website",
      "--tailwind",
      "--no-tailwind",
    ]);
    assertEquals(result, "");
    assert(Deno.exitCode === 1);
    assertStringIncludes(errors.join("\n"), "Contradictory flags");
    assertStringIncludes(errors.join("\n"), "--tailwind");
    assertStringIncludes(errors.join("\n"), "--no-tailwind");
  } finally {
    console.error = originalError;
    Deno.exitCode = 0;
  }
});

// Non-interactive scaffolding. Creates files in a temp directory and cleans up.
Deno.test("project scaffolds non-interactively with flags", async () => {
  const tmpDir = await Deno.makeTempDir();
  const originalCwd = Deno.cwd();
  const originalExitCode = Deno.exitCode;
  try {
    Deno.chdir(tmpDir);
    Deno.exitCode = 0;
    const result = await project([
      "my-app",
      "--type=website",
      "--tailwind",
      "--no-skills",
    ]);
    assertStringIncludes(result, "Website application created!");
    assert(Deno.exitCode === 0);

    // Core scaffold files
    assert(await dirExists(join(tmpDir, "my-app")));
    assert(await fileExists(join(tmpDir, "my-app", "package.json")));
    assert(await fileExists(join(tmpDir, "my-app", "server.ts")));
    assert(await fileExists(join(tmpDir, "my-app", "vite.config.ts")));
    assert(await fileExists(join(tmpDir, "my-app", "app", "root.tsx")));
    assert(await fileExists(join(tmpDir, "my-app", "app", "page.tsx")));

    // --tailwind creates styles
    assert(await fileExists(join(tmpDir, "my-app", "src", "styles.css")));
    const pkg = JSON.parse(
      await Deno.readTextFile(join(tmpDir, "my-app", "package.json")),
    );
    assertEquals(pkg.dependencies["@huuma/ui"], "jsr:^0.3.0-beta.1");
    assertEquals(
      pkg.scripts["dev:css"],
      "tailwindcss -i src/styles.css -o public/styles.css --watch",
    );

    // --no-skills and no --zed/--vscode: these dirs should not exist
    assert(!await dirExists(join(tmpDir, "my-app", ".zed")));
    assert(!await dirExists(join(tmpDir, "my-app", ".vscode")));
  } finally {
    Deno.chdir(originalCwd);
    Deno.exitCode = originalExitCode;
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("project --no-tailwind skips Tailwind styles", async () => {
  const tmpDir = await Deno.makeTempDir();
  const originalCwd = Deno.cwd();
  const originalExitCode = Deno.exitCode;
  try {
    Deno.chdir(tmpDir);
    Deno.exitCode = 0;
    await project([
      "no-tailwind-app",
      "--type=website",
      "--no-tailwind",
      "--no-skills",
    ]);

    assert(
      !await fileExists(join(tmpDir, "no-tailwind-app", "src", "styles.css")),
    );
    assert(
      !await fileExists(
        join(tmpDir, "no-tailwind-app", "public", "styles.css"),
      ),
    );
  } finally {
    Deno.chdir(originalCwd);
    Deno.exitCode = originalExitCode;
    await Deno.remove(tmpDir, { recursive: true });
  }
});

for (
  const option of [
    "--zed",
    "--no-zed",
    "--vscode",
    "--no-vscode",
    "--package-manager=unknown",
    "--package-manager=",
  ]
) {
  Deno.test(`project rejects ${option} before creating a directory`, async () => {
    const tmpDir = await Deno.makeTempDir();
    const originalCwd = Deno.cwd();
    const originalExitCode = Deno.exitCode;
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args) => errors.push(args.join(" "));
    try {
      Deno.chdir(tmpDir);
      Deno.exitCode = 0;
      await project([
        "invalid-app",
        "--type=website",
        option,
        "--no-skills",
      ]);

      assertEquals(Deno.exitCode, 1);
      assert(!await dirExists(join(tmpDir, "invalid-app")));
      assertStringIncludes(
        errors.join("\n"),
        option.startsWith("--package-manager")
          ? "Valid package managers: pnpm, npm, yarn, bun"
          : "Unknown option",
      );
    } finally {
      Deno.chdir(originalCwd);
      Deno.exitCode = originalExitCode;
      console.error = originalError;
      await Deno.remove(tmpDir, { recursive: true });
    }
  });
}

Deno.test("project forwards package-manager and install flags", async () => {
  const tmpDir = await Deno.makeTempDir();
  const originalCwd = Deno.cwd();
  const originalExitCode = Deno.exitCode;
  let installed = false;
  try {
    Deno.chdir(tmpDir);
    await projectCommand([
      "my-app",
      "--type",
      "website",
      "--package-manager",
      "npm",
      "--install",
      "--no-tailwind",
      "--no-skills",
    ], {
      fetch: fetchMetadata,
      install: (pm, cwd) => {
        assertEquals(pm, "npm");
        assertEquals(cwd, "my-app");
        installed = true;
        return Promise.resolve({ success: true, code: 0 });
      },
    });
    assert(installed);
    assert(await fileExists(join(tmpDir, "my-app", ".npmrc")));
  } finally {
    Deno.chdir(originalCwd);
    Deno.exitCode = originalExitCode;
    await Deno.remove(tmpDir, { recursive: true });
  }
});

async function dirExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await Deno.stat(path);
    return info.isFile;
  } catch {
    return false;
  }
}
