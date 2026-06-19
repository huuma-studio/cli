import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { TarStream } from "@std/tar/tar-stream";
import { join } from "@std/path";
import { ExtractError, extractSkill, SIZE_CAP } from "./extract.ts";

/** Builds an in-memory (uncompressed) tarball as a ReadableStream from a list
 * of `{ path, content? }` entries. Directories are inferred from file paths;
 * pass `{ type: "symlink", path, linkname }` for a symlink probe. */
type Entry =
  | { type?: "file"; path: string; content: Uint8Array | string }
  | { type: "symlink"; path: string; linkname: string };

function buildTarball(entries: Entry[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const input = entries.map((e) => {
    if (e.type === "symlink") {
      return { type: "symlink" as const, path: e.path, linkname: e.linkname };
    }
    const bytes = e.content instanceof Uint8Array
      ? e.content
      : encoder.encode(e.content);
    return {
      type: "file" as const,
      path: e.path,
      size: bytes.byteLength,
      readable: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
  });
  return ReadableStream.from(input).pipeThrough(new TarStream());
}

async function readDirTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isDirectory) {
      for (const child of await readDirTree(join(dir, entry.name))) {
        out.push(`${entry.name}/${child}`);
      }
    } else {
      out.push(entry.name);
    }
  }
  return out.sort();
}

Deno.test("extracts a normal skill with nested dirs and filters siblings", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const tar = buildTarball([
      {
        path: "skills-main/skills/mcp-builder/SKILL.md",
        content: "name: mcp-builder",
      },
      {
        path: "skills-main/skills/mcp-builder/scripts/run.sh",
        content: "echo hi",
      },
      { path: "skills-main/skills/other/SKILL.md", content: "name: other" },
      { path: "skills-main/README.md", content: "repo readme" },
    ]);
    await extractSkill({
      tarball: tar,
      subpath: ["skills", "mcp-builder"],
      destDir: tmp,
    });
    const tree = await readDirTree(tmp);
    assertEquals(tree, ["SKILL.md", "scripts/run.sh"]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("extracts repo-root skill (no subpath)", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const tar = buildTarball([
      { path: "repo-main/SKILL.md", content: "name: repo" },
      { path: "repo-main/assets/logo.txt", content: "L" },
    ]);
    await extractSkill({ tarball: tar, subpath: [], destDir: tmp });
    const tree = await readDirTree(tmp);
    assertEquals(tree, ["SKILL.md", "assets/logo.txt"]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("top dir name uses <shortsha> form, not just <ref>", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const tar = buildTarball([
      { path: "skills-abc123/SKILL.md", content: "name: x" },
    ]);
    await extractSkill({ tarball: tar, subpath: [], destDir: tmp });
    const tree = await readDirTree(tmp);
    assertEquals(tree, ["SKILL.md"]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("rejects path-traversal entry and aborts", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const tar = buildTarball([
      { path: "skills-main/SKILL.md", content: "ok" },
      {
        path: "skills-main/../escape.txt",
        content: "pwned",
      },
    ]);
    await assertRejects(
      () =>
        extractSkill({
          tarball: tar,
          subpath: [],
          destDir: tmp,
        }),
      ExtractError,
      "outside the install directory",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("skips symlink entries silently", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const tar = buildTarball([
      { path: "skills-main/SKILL.md", content: "ok" },
      {
        type: "symlink",
        path: "skills-main/link",
        linkname: "../../etc/passwd",
      },
    ]);
    await extractSkill({ tarball: tar, subpath: [], destDir: tmp });
    const tree = await readDirTree(tmp);
    // symlink not recreated
    assertEquals(tree, ["SKILL.md"]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("rejects a file exceeding per-file cap", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const big = new Uint8Array(11);
    const tar = buildTarball([
      { path: "skills-main/SKILL.md", content: "ok" },
      { path: "skills-main/big.bin", content: big },
    ]);
    const err = await assertRejects(
      () =>
        extractSkill({
          tarball: tar,
          subpath: [],
          destDir: tmp,
          sizeCap: { totalBytes: 100, perFileBytes: 10 },
        }),
      ExtractError,
    );
    assertStringIncludes(err.message, "per-file cap");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("rejects when total bytes exceed total cap", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const tar = buildTarball([
      { path: "skills-main/a.txt", content: "aaaaa" }, // 5
      { path: "skills-main/b.txt", content: "bbbbb" }, // 5
      { path: "skills-main/c.txt", content: "ccccc" }, // 5 -> total 15 > 10
    ]);
    const err = await assertRejects(
      () =>
        extractSkill({
          tarball: tar,
          subpath: [],
          destDir: tmp,
          sizeCap: { totalBytes: 10, perFileBytes: 100 },
        }),
      ExtractError,
    );
    assertStringIncludes(err.message, "total size cap");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("SIZE_CAP default is 50MiB total / 10MiB per file", () => {
  assertEquals(SIZE_CAP.totalBytes, 50 * 1024 * 1024);
  assertEquals(SIZE_CAP.perFileBytes, 10 * 1024 * 1024);
});
