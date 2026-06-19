import { assertEquals, assertStringIncludes } from "@std/assert";
import skills from "./skills.ts";

Deno.test("skills with no args returns help listing 'add'", async () => {
  const out = await skills([]);
  assertStringIncludes(out, "huuma skills");
  assertStringIncludes(out, "add");
});

Deno.test("skills --help returns the same help", async () => {
  const out = await skills(["--help"]);
  assertStringIncludes(out, "huuma skills");
  assertStringIncludes(out, "add");
});

Deno.test("skills -h returns the same help", async () => {
  const out = await skills(["-h"]);
  assertStringIncludes(out, "huuma skills");
});

Deno.test("skills add --help delegates to add's usage", async () => {
  const out = await skills(["add", "--help"]);
  assertStringIncludes(out, "huuma skills add");
  assertStringIncludes(out, "--path");
});

Deno.test("skills bogus prints a red error and sets exit 1", async () => {
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (msg: string) => {
    errs.push(typeof msg === "string" ? msg : String(msg));
  };
  try {
    const out = await skills(["bogus"]);
    assertEquals(out, "");
    assertStringIncludes(errs.join("\n"), "Unknown skills sub-command");
    assertStringIncludes(errs.join("\n"), "bogus");
    assertEquals(Deno.exitCode, 1);
  } finally {
    console.error = origErr;
    Deno.exitCode = 0;
  }
});
