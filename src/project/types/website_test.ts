import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { create as createDir } from "../directory.ts";
import website, {
  type BundleFn,
  denoConfigContent,
  devTsContent,
  installBundleForWebsite,
  rootTsContent,
  type WebsiteBundleOutcome,
} from "./website.ts";
import { BundleValidationError } from "../../skills/bundle.ts";

// `denoConfigContent` resolves dep versions through `latest()`, which falls back
// gracefully when offline — so these run with net denied to stay hermetic. The
// assertions check structure, not the resolved version numbers.

Deno.test(
  "deno.json adds Tailwind deps and nodeModulesDir when enabled",
  { permissions: { net: false } },
  async () => {
    const content = await denoConfigContent(true);
    assertStringIncludes(content, `"@huuma/theme": "jsr:@huuma/theme@^`);
    assertStringIncludes(content, `"tailwindcss": "npm:tailwindcss@^4"`);
    assertStringIncludes(
      content,
      `"@tailwindcss/cli": "npm:@tailwindcss/cli@^4"`,
    );
    assertStringIncludes(content, `"nodeModulesDir": "auto"`);
  },
);

Deno.test(
  "deno.json omits Tailwind config when disabled",
  { permissions: { net: false } },
  async () => {
    const content = await denoConfigContent(false);
    assertEquals(content.includes("tailwindcss"), false);
    assertEquals(content.includes("@huuma/theme"), false);
    assertEquals(content.includes("nodeModulesDir"), false);
  },
);

Deno.test("root.tsx links /styles.css when Tailwind is enabled", () => {
  const content = rootTsContent(true);
  assertStringIncludes(content, `<link rel="stylesheet" href="/styles.css" />`);
});

Deno.test("root.tsx omits the stylesheet link when disabled", () => {
  assertEquals(rootTsContent(false).includes("styles.css"), false);
});

Deno.test("dev.ts imports and runs tailwindcss when enabled", () => {
  const content = devTsContent(true);
  assertStringIncludes(
    content,
    `import { tailwindcss } from "@huuma/theme/tailwind";`,
  );
  assertStringIncludes(content, `await tailwindcss();`);
});

Deno.test("dev.ts omits tailwindcss when disabled", () => {
  assertEquals(devTsContent(false).includes("tailwindcss"), false);
});

Deno.test("installBundleForWebsite propagates the bundle result on success", async () => {
  const fixed: WebsiteBundleOutcome = {
    members: [
      {
        name: "mcp-builder",
        target: "/demo/.agents/skills/mcp-builder",
        warnings: [],
      },
      {
        name: "domain-modeling",
        target: "/demo/.agents/skills/domain-modeling",
        warnings: ["a warning"],
      },
    ],
    failed: false,
  };
  const stub: BundleFn = (_opts) => Promise.resolve({ members: fixed.members });
  const outcome = await installBundleForWebsite("demo", stub);
  assertEquals(outcome.members, fixed.members);
  assertEquals(outcome.failed, false);
  assertEquals(Deno.exitCode === 1, false);
});

Deno.test("installBundleForWebsite swallows bundle errors, sets exit 1, and marks failed", async () => {
  const errs: string[] = [];
  const originalError = console.error;
  console.error = (msg: string) => errs.push(String(msg));
  try {
    const throwing: BundleFn = (_opts) =>
      Promise.reject(
        new BundleValidationError(
          "Bundle member 'bad' failed validation: bad name",
        ),
      );
    const outcome = await installBundleForWebsite("demo", throwing);
    assertEquals(outcome.members.length, 0);
    assertEquals(outcome.failed, true);
    assertEquals(Deno.exitCode, 1);
    const joined = errs.join("\n");
    assertStringIncludes(joined, "✖");
    assertStringIncludes(joined, "bad");
  } finally {
    console.error = originalError;
    Deno.exitCode = 0;
  }
});

// Non-interactive scaffolding tests. These exercise the WebsiteOptions path
// where all booleans are set, skipping all confirm prompts. They use temp
// directories and clean up after. `denoConfigContent` calls `latest()` which
// needs network, so these require --allow-net.

Deno.test("website with all options set scaffolds without prompts", async () => {
  const tmpDir = await Deno.makeTempDir();
  const originalCwd = Deno.cwd();
  try {
    Deno.chdir(tmpDir);
    await createDir("test-app");
    await website("test-app", {
      zed: true,
      vscode: false,
      tailwind: true,
      skills: false,
    });
    assert(await fileExists(join(tmpDir, "test-app", "deno.json")));
    assert(await fileExists(join(tmpDir, "test-app", "app.ts")));
    assert(await fileExists(join(tmpDir, "test-app", "app", "root.tsx")));
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("tailwind: true produces src/styles.css and static/styles.css", async () => {
  const tmpDir = await Deno.makeTempDir();
  const originalCwd = Deno.cwd();
  try {
    Deno.chdir(tmpDir);
    await createDir("tw-app");
    await website("tw-app", { tailwind: true, skills: false });
    assert(await fileExists(join(tmpDir, "tw-app", "src", "styles.css")));
    assert(await fileExists(join(tmpDir, "tw-app", "static", "styles.css")));
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("tailwind: false does not produce Tailwind files", async () => {
  const tmpDir = await Deno.makeTempDir();
  const originalCwd = Deno.cwd();
  try {
    Deno.chdir(tmpDir);
    await createDir("no-tw-app");
    await website("no-tw-app", { tailwind: false, skills: false });
    assert(!await fileExists(join(tmpDir, "no-tw-app", "src", "styles.css")));
    assert(
      !await fileExists(join(tmpDir, "no-tw-app", "static", "styles.css")),
    );
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("zed: true produces .zed/settings.json; zed: false does not", async () => {
  const tmpDir = await Deno.makeTempDir();
  const originalCwd = Deno.cwd();
  try {
    Deno.chdir(tmpDir);
    await createDir("zed-true");
    await website("zed-true", { zed: true, skills: false });
    assert(await fileExists(join(tmpDir, "zed-true", ".zed", "settings.json")));

    await createDir("zed-false");
    await website("zed-false", { zed: false, skills: false });
    assert(!await dirExists(join(tmpDir, "zed-false", ".zed")));
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("skills: false does not attempt a bundle install", async () => {
  const tmpDir = await Deno.makeTempDir();
  const originalCwd = Deno.cwd();
  const originalExitCode = Deno.exitCode;
  try {
    Deno.chdir(tmpDir);
    Deno.exitCode = 0;
    await createDir("no-skills-app");
    await website("no-skills-app", { zed: false, vscode: false, tailwind: false, skills: false });
    // No bundle install attempted: exit code stays 0, no .agents dir created
    assertEquals(Deno.exitCode, 0);
    assert(!await dirExists(join(tmpDir, "no-skills-app", ".agents")));
  } finally {
    Deno.chdir(originalCwd);
    Deno.exitCode = originalExitCode;
    await Deno.remove(tmpDir, { recursive: true });
  }
});

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await Deno.stat(path);
    return info.isFile;
  } catch {
    return false;
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
