import { assertEquals, assertStringIncludes } from "@std/assert";
import {
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
