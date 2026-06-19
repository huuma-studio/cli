import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { validateSkill, ValidationError } from "./validate.ts";

const testdata = (sub: string) => join(import.meta.dirname!, "testdata", sub);

Deno.test("valid skill returns name and no warnings", async () => {
  const result = await validateSkill(testdata("valid-skill"));
  assertEquals(result.name, "valid-skill");
  assertEquals(result.warnings, []);
});

Deno.test("rejects when SKILL.md is missing", async () => {
  const err = await assertRejects(
    () => validateSkill(testdata("missing-skill-md")),
    ValidationError,
  );
  assertStringIncludes(err.message, "SKILL.md not found");
});

Deno.test("rejects when name fails the regex", async () => {
  const err = await assertRejects(
    () => validateSkill(testdata("invalid-name")),
    ValidationError,
  );
  assertStringIncludes(err.message, "name");
});

Deno.test("rejects when name does not match the dir basename", async () => {
  // The valid-skill fixture has name 'valid-skill'; validate against a
  // differently-named dir to trigger the basename invariant.
  const tmp = await Deno.makeTempDir();
  try {
    const dir = join(tmp, "renamed");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.copyFile(
      testdata("valid-skill/SKILL.md"),
      join(dir, "SKILL.md"),
    );
    const err = await assertRejects(
      () => validateSkill(dir),
      ValidationError,
    );
    assertStringIncludes(
      err.message,
      "must match the skill directory basename",
    );
    assertStringIncludes(err.message, "renamed");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("rejects when description is missing", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const dir = join(tmp, "no-desc");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      join(dir, "SKILL.md"),
      `---
name: no-desc
---
body`,
    );
    const err = await assertRejects(
      () => validateSkill(dir),
      ValidationError,
    );
    assertStringIncludes(err.message, "description");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("optional-field warnings are collected but do not reject", async () => {
  const result = await validateSkill(testdata("optional-warnings"));
  assertEquals(result.name, "optional-warnings");
  // compatibility > 500 chars
  assertStringIncludes(result.warnings.join("\n"), "compatibility");
  // license non-string
  assertStringIncludes(result.warnings.join("\n"), "license");
  // metadata.count non-string
  assertStringIncludes(result.warnings.join("\n"), "metadata.count");
  // allowed-tools not an array
  assertStringIncludes(result.warnings.join("\n"), "allowed-tools");
});
