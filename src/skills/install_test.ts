import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { TarStream } from "@std/tar/tar-stream";
import { CollisionError, installSkill, LocalEditsError } from "./install.ts";
import { readManifest } from "./manifest.ts";
import type { ParsedPath } from "./path.ts";

const encoder = new TextEncoder();

/** Builds a plain (uncompressed) tarball stream. The fetch seam returns
 * decompressed bytes, matching what `downloadTarball` yields after gzip. */
function buildTarball(
  files: { path: string; content: string }[],
): ReadableStream<Uint8Array> {
  const input = files.map((f) => {
    const bytes = encoder.encode(f.content);
    return {
      type: "file" as const,
      path: f.path,
      size: bytes.byteLength,
      readable: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
    };
  });
  return ReadableStream.from(input).pipeThrough(new TarStream());
}

/** Builds a tarball whose top dir is `skills-main/` and the skill lives under
 * `skills/mcp-builder/` (the ADR's canonical layout). */
function mcpBuilderTarball(
  name = "mcp-builder",
  content = "name: mcp-builder",
): ReadableStream<Uint8Array> {
  return buildTarball([
    {
      path: `skills-main/skills/${name}/SKILL.md`,
      content:
        `---\nname: ${name}\ndescription: ${name} skill\n---\n# ${name}\n${content}`,
    },
    { path: `skills-main/skills/${name}/scripts/run.sh`, content: "echo hi" },
    { path: `skills-main/README.md`, content: "repo readme" },
  ]);
}

const parsedAnthropics: ParsedPath = {
  owner: "anthropics",
  repo: "skills",
  ref: "main",
  subpath: ["skills", "mcp-builder"],
};

const parsedOther: ParsedPath = {
  owner: "other",
  repo: "skills",
  ref: "main",
  subpath: ["skills", "mcp-builder"],
};

const noopLog = (_line: string) => {};

Deno.test("fresh install writes SKILL.md and a manifest entry", async () => {
  const cwd = await Deno.makeTempDir();
  try {
    const result = await installSkill({
      parsed: parsedAnthropics,
      force: false,
      cwd,
      fetch: () => Promise.resolve(mcpBuilderTarball()),
      log: noopLog,
    });
    assertEquals(result.name, "mcp-builder");
    assertStringIncludes(
      result.target,
      join(".agents", "skills", "mcp-builder"),
    );

    const skillMd = await Deno.readTextFile(
      join(cwd, ".agents", "skills", "mcp-builder", "SKILL.md"),
    );
    assertStringIncludes(skillMd, "name: mcp-builder");

    const manifest = await readManifest(join(cwd, ".agents", "skills"));
    const entry = manifest.skills["mcp-builder"];
    assert(entry, "manifest entry exists");
    assertEquals(entry.source.owner, "anthropics");
    assertStringIncludes(entry.contentHash, "sha256-");

    // No stray .tmp-/.old- dirs left behind.
    const names: string[] = [];
    for await (const e of Deno.readDir(join(cwd, ".agents", "skills"))) {
      names.push(e.name);
    }
    assertEquals(
      names.filter((n) => n.startsWith(".tmp-") || n.startsWith(".old-"))
        .length,
      0,
    );
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("re-add same source overwrites and refreshes the hash", async () => {
  const cwd = await Deno.makeTempDir();
  try {
    await installSkill({
      parsed: parsedAnthropics,
      force: false,
      cwd,
      fetch: () => Promise.resolve(mcpBuilderTarball("mcp-builder", "v1")),
      log: noopLog,
    });
    const before =
      (await readManifest(join(cwd, ".agents", "skills"))).skills["mcp-builder"]
        .contentHash;

    await installSkill({
      parsed: parsedAnthropics,
      force: false,
      cwd,
      fetch: () => Promise.resolve(mcpBuilderTarball("mcp-builder", "v2")),
      log: noopLog,
    });
    const after =
      (await readManifest(join(cwd, ".agents", "skills"))).skills["mcp-builder"]
        .contentHash;
    assertEquals(before !== after, true);
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("re-add different source refuses without --force and leaves the original", async () => {
  const cwd = await Deno.makeTempDir();
  try {
    await installSkill({
      parsed: parsedAnthropics,
      force: false,
      cwd,
      fetch: () => Promise.resolve(mcpBuilderTarball()),
      log: noopLog,
    });
    const err = await assertRejects(
      () =>
        installSkill({
          parsed: parsedOther,
          force: false,
          cwd,
          fetch: () => Promise.resolve(mcpBuilderTarball()),
          log: noopLog,
        }),
      CollisionError,
    );
    assertStringIncludes(err.message, "already installed");
    assertStringIncludes(err.message, "--force");

    // Original install untouched: still anthropics.
    const manifest = await readManifest(join(cwd, ".agents", "skills"));
    assertEquals(manifest.skills["mcp-builder"].source.owner, "anthropics");
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("re-add different source with --force overwrites and updates the source", async () => {
  const cwd = await Deno.makeTempDir();
  try {
    await installSkill({
      parsed: parsedAnthropics,
      force: false,
      cwd,
      fetch: () => Promise.resolve(mcpBuilderTarball()),
      log: noopLog,
    });
    await installSkill({
      parsed: parsedOther,
      force: true,
      cwd,
      fetch: () => Promise.resolve(mcpBuilderTarball()),
      log: noopLog,
    });
    const manifest = await readManifest(join(cwd, ".agents", "skills"));
    assertEquals(manifest.skills["mcp-builder"].source.owner, "other");
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("local edits refuse same-source re-add without --force", async () => {
  const cwd = await Deno.makeTempDir();
  try {
    await installSkill({
      parsed: parsedAnthropics,
      force: false,
      cwd,
      fetch: () => Promise.resolve(mcpBuilderTarball()),
      log: noopLog,
    });
    // Hand-edit the installed skill.
    await Deno.writeTextFile(
      join(cwd, ".agents", "skills", "mcp-builder", "SKILL.md"),
      "---\nname: mcp-builder\ndescription: edited\n---\n# edited\n",
    );
    const err = await assertRejects(
      () =>
        installSkill({
          parsed: parsedAnthropics,
          force: false,
          cwd,
          fetch: () => Promise.resolve(mcpBuilderTarball()),
          log: noopLog,
        }),
      LocalEditsError,
    );
    assertStringIncludes(err.message, "local edits");
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("local edits with --force overwrites", async () => {
  const cwd = await Deno.makeTempDir();
  try {
    await installSkill({
      parsed: parsedAnthropics,
      force: false,
      cwd,
      fetch: () => Promise.resolve(mcpBuilderTarball()),
      log: noopLog,
    });
    await Deno.writeTextFile(
      join(cwd, ".agents", "skills", "mcp-builder", "SKILL.md"),
      "---\nname: mcp-builder\ndescription: edited\n---\n# edited\n",
    );
    await installSkill({
      parsed: parsedAnthropics,
      force: true,
      cwd,
      fetch: () => Promise.resolve(mcpBuilderTarball()),
      log: noopLog,
    });
    // The re-install should have restored the canonical SKILL.md content.
    const skillMd = await Deno.readTextFile(
      join(cwd, ".agents", "skills", "mcp-builder", "SKILL.md"),
    );
    assertStringIncludes(skillMd, "name: mcp-builder");
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("validation failure cleans up the temp dir and leaves no install", async () => {
  const cwd = await Deno.makeTempDir();
  try {
    // Bad name in frontmatter.
    const bad = buildTarball([
      {
        path: "skills-main/skills/Bad_Name/SKILL.md",
        content: "---\nname: Bad_Name\ndescription: bad\n---\n",
      },
    ]);
    await assertRejects(
      () =>
        installSkill({
          parsed: {
            owner: "anthropics",
            repo: "skills",
            ref: "main",
            subpath: ["skills", "Bad_Name"],
          },
          force: false,
          cwd,
          fetch: () => Promise.resolve(bad),
          log: noopLog,
        }),
    );

    // No skill dir, no stray .tmp- dirs.
    const skillsDir = join(cwd, ".agents", "skills");
    const names: string[] = [];
    for await (const e of Deno.readDir(skillsDir)) names.push(e.name);
    assertEquals(names.filter((n) => !n.startsWith(".")).length, 0); // no skill dirs
    assertEquals(names.filter((n) => n.startsWith(".tmp-")).length, 0);
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("path-traversal entry aborts and writes nothing outside the target", async () => {
  const cwd = await Deno.makeTempDir();
  try {
    const evil = buildTarball([
      {
        path: "skills-main/skills/mcp-builder/SKILL.md",
        content: "---\nname: mcp-builder\ndescription: x\n---\n",
      },
      {
        path: "skills-main/skills/mcp-builder/../escape.txt",
        content: "pwned",
      },
    ]);
    await assertRejects(
      () =>
        installSkill({
          parsed: parsedAnthropics,
          force: false,
          cwd,
          fetch: () => Promise.resolve(evil),
          log: noopLog,
        }),
    );

    // No escape.txt written to the skills dir parent.
    let escaped = false;
    try {
      await Deno.stat(join(cwd, ".agents", "skills", "escape.txt"));
      escaped = true;
    } catch {
      escaped = false;
    }
    assertEquals(escaped, false);
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});
