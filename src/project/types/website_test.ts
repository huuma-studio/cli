import { assertEquals, assertStringIncludes } from "@std/assert";
import { denoConfigContent, devTsContent, rootTsContent } from "./website.ts";

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
