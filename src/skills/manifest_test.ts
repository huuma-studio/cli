import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  contentHashOf,
  detectLocalEdits,
  findCollision,
  type Manifest,
  readManifest,
  writeManifest,
} from "./manifest.ts";
import type { Source } from "./path.ts";

const source: Source = {
  owner: "anthropics",
  repo: "skills",
  ref: "main",
  subpath: ["skills", "mcp-builder"],
};

Deno.test("writeManifest + readManifest round-trip", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const m: Manifest = {
      skills: {
        "mcp-builder": {
          source,
          contentHash: "sha256-deadbeef",
          installedAt: "2026-06-18T12:00:00Z",
        },
      },
    };
    await writeManifest(dir, m);
    const back = await readManifest(dir);
    assertEquals(back.skills["mcp-builder"].contentHash, "sha256-deadbeef");
    assertEquals(back.skills["mcp-builder"].source.owner, "anthropics");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readManifest returns empty when the file is missing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const m = await readManifest(dir);
    assertEquals(m.skills, {});
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readManifest returns empty when the file is unparseable", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, ".manifest.json"), "{ not json");
    const m = await readManifest(dir);
    assertEquals(m.skills, {});
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findCollision returns 'none' for an uninstalled name", () => {
  const m: Manifest = { skills: {} };
  assertEquals(findCollision(m, "x", source), "none");
});

Deno.test("findCollision returns 'same-source' for same owner/repo (ref may differ)", () => {
  const m: Manifest = {
    skills: {
      "mcp-builder": {
        source: { ...source, ref: "v1" },
        contentHash: "sha256-x",
        installedAt: "2026-01-01T00:00:00Z",
      },
    },
  };
  assertEquals(findCollision(m, "mcp-builder", source), "same-source");
});

Deno.test("findCollision returns 'different-source' for a different owner/repo", () => {
  const m: Manifest = {
    skills: {
      "mcp-builder": {
        source: { owner: "other", repo: "skills", ref: "main", subpath: [] },
        contentHash: "sha256-x",
        installedAt: "2026-01-01T00:00:00Z",
      },
    },
  };
  assertEquals(findCollision(m, "mcp-builder", source), "different-source");
});

Deno.test("contentHashOf is stable across two reads of the same tree", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const skill = join(dir, "mcp-builder");
    await Deno.mkdir(join(skill, "scripts"), { recursive: true });
    await Deno.writeTextFile(join(skill, "SKILL.md"), "name: mcp-builder");
    await Deno.writeTextFile(join(skill, "scripts/run.sh"), "echo hi");
    const h1 = await contentHashOf(skill);
    const h2 = await contentHashOf(skill);
    assertEquals(h1, h2);
    assertStringIncludes(h1, "sha256-");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("contentHashOf changes when a file changes", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const skill = join(dir, "mcp-builder");
    await Deno.mkdir(skill, { recursive: true });
    await Deno.writeTextFile(join(skill, "SKILL.md"), "name: mcp-builder");
    const h1 = await contentHashOf(skill);
    await Deno.writeTextFile(
      join(skill, "SKILL.md"),
      "name: mcp-builder\nedited",
    );
    const h2 = await contentHashOf(skill);
    assertEquals(h1 !== h2, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("detectLocalEdits returns false when the skill is not in the manifest", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const m: Manifest = { skills: {} };
    assertEquals(await detectLocalEdits(m, "missing", dir), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("detectLocalEdits returns false when hashes match and true when they diverge", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const skill = join(dir, "mcp-builder");
    await Deno.mkdir(skill, { recursive: true });
    await Deno.writeTextFile(join(skill, "SKILL.md"), "name: mcp-builder");
    const hash = await contentHashOf(skill);

    const m: Manifest = {
      skills: {
        "mcp-builder": {
          source,
          contentHash: hash,
          installedAt: "2026-01-01T00:00:00Z",
        },
      },
    };
    assertEquals(await detectLocalEdits(m, "mcp-builder", dir), false);

    // Edit the file — hash should now diverge.
    await Deno.writeTextFile(
      join(skill, "SKILL.md"),
      "name: mcp-builder\nedited",
    );
    assertEquals(await detectLocalEdits(m, "mcp-builder", dir), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
