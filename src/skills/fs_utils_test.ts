import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { randomSuffix, swapDirectory, sweepStaleTemps } from "./fs_utils.ts";

async function write(path: string, content: string): Promise<void> {
  await Deno.mkdir(join(path, ".."), { recursive: true });
  await Deno.writeTextFile(path, content);
}

Deno.test("sweepStaleTemps removes .tmp-* and .old-* but leaves skills and manifest", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, ".tmp-foo"));
    await Deno.mkdir(join(dir, ".old-bar"));
    await Deno.mkdir(join(dir, "mcp-builder"));
    await write(join(dir, "mcp-builder", "SKILL.md"), "name: mcp-builder");
    await write(join(dir, ".manifest.json"), "{}");

    await sweepStaleTemps(dir);

    const names = new Set<string>();
    for await (const e of Deno.readDir(dir)) names.add(e.name);
    assertEquals(names, new Set(["mcp-builder", ".manifest.json"]));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sweepStaleTemps on a non-existent dir resolves without throwing", async () => {
  await sweepStaleTemps(join(await Deno.makeTempDir(), "does-not-exist"));
});

Deno.test("randomSuffix returns 8 hex chars", () => {
  const s = randomSuffix();
  assertEquals(s.length, 8);
  assertEquals(/^[0-9a-f]{8}$/.test(s), true);
});

Deno.test("swapDirectory into a non-existent target is a single rename", async () => {
  const parent = await Deno.makeTempDir();
  const tempDir = join(parent, ".tmp-abc");
  const target = join(parent, "skill");
  try {
    await Deno.mkdir(tempDir);
    await write(join(tempDir, "SKILL.md"), "name: skill");

    await swapDirectory({ tempDir, target });

    assertEquals(
      await Deno.readTextFile(join(target, "SKILL.md")),
      "name: skill",
    );
    // temp dir is gone (renamed into place).
    let tempExists = true;
    try {
      await Deno.stat(tempDir);
    } catch {
      tempExists = false;
    }
    assertEquals(tempExists, false);
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("swapDirectory over an existing target swaps content and deletes the old dir", async () => {
  const parent = await Deno.makeTempDir();
  const tempDir = join(parent, ".tmp-new");
  const target = join(parent, "skill");
  try {
    await Deno.mkdir(target);
    await write(join(target, "old.txt"), "old");
    await Deno.mkdir(tempDir);
    await write(join(tempDir, "new.txt"), "new");

    await swapDirectory({ tempDir, target });

    assertEquals(await Deno.readTextFile(join(target, "new.txt")), "new");
    // old content is gone.
    let oldExists = true;
    try {
      await Deno.readTextFile(join(target, "old.txt"));
    } catch {
      oldExists = false;
    }
    assertEquals(oldExists, false);

    // No stray .old-* dirs left behind.
    const names: string[] = [];
    for await (const e of Deno.readDir(parent)) names.push(e.name);
    assertEquals(names.filter((n) => n.startsWith(".old-")).length, 0);
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("swapDirectory restores target when the second rename fails", async () => {
  const parent = await Deno.makeTempDir();
  const target = join(parent, "skill");
  try {
    await Deno.mkdir(target);
    await write(join(target, "original.txt"), "original");

    // tempDir does not exist, so the second rename (tempDir -> target) fails.
    // The rollback must restore `target` from the .old-<rand> dir.
    await assertRejects(
      () => swapDirectory({ tempDir: join(parent, ".tmp-missing"), target }),
    );

    // target still holds the original content.
    assertEquals(
      await Deno.readTextFile(join(target, "original.txt")),
      "original",
    );

    // No stray .old-* dirs left behind after rollback.
    const names: string[] = [];
    for await (const e of Deno.readDir(parent)) names.push(e.name);
    assertEquals(names.filter((n) => n.startsWith(".old-")).length, 0);
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});
