import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { TarStream } from "@std/tar/tar-stream";
import { BundleValidationError, installBundle } from "./bundle.ts";
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

/** Builds a bundle tarball whose top dir is `repo-main/`, with one
 * `skills/<name>/SKILL.md` per member plus a sibling `skills/not-a-skill/`
 * dir (no `SKILL.md`) and a root `README.md`. Mirrors `huuma-studio/ui`'s
 * layout. */
function buildBundleTarball(
  members: { name: string; description?: string; body?: string }[],
): ReadableStream<Uint8Array> {
  const files: { path: string; content: string }[] = [];
  for (const m of members) {
    const description = m.description ?? `${m.name} skill`;
    const body = m.body ?? `# ${m.name}`;
    files.push({
      path: `repo-main/skills/${m.name}/SKILL.md`,
      content:
        `---\nname: ${m.name}\ndescription: ${description}\n---\n${body}\n`,
    });
  }
  // Sibling with no SKILL.md — must be skipped by discovery.
  files.push({
    path: `repo-main/skills/not-a-skill/README.md`,
    content: "just a readme",
  });
  // Root readme — outside the skills/ subpath, filtered by extractSkill.
  files.push({ path: `repo-main/README.md`, content: "repo readme" });
  return buildTarball(files);
}

const parsedHuumaUi: ParsedPath = {
  owner: "huuma-studio",
  repo: "ui",
  ref: "main",
  subpath: ["skills"],
};

const noopLog = (_line: string) => {};

/** Lists non-dotfile entries under `.agents/skills/` — used to assert no stray
 * skill dirs are left after an aborted bundle. */
async function skillDirNames(skillsDir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const e of Deno.readDir(skillsDir)) names.push(e.name);
  return names;
}

/** Recursively walks `root` and returns true if a file named `name` exists at
 * any depth. Used by the path-traversal test to verify no escaped file landed
 * anywhere under `.agents/` — not just at the previously-checked (wrong) path. */
async function containsFileRecursive(
  root: string,
  name: string,
): Promise<boolean> {
  try {
    for await (const entry of Deno.readDir(root)) {
      if (entry.isFile && entry.name === name) return true;
      if (entry.isDirectory) {
        if (await containsFileRecursive(join(root, entry.name), name)) {
          return true;
        }
      }
    }
  } catch {
    // dir missing — nothing to find.
  }
  return false;
}

Deno.test("fresh bundle install writes every member and a manifest entry per member", async () => {
  const cwd = await Deno.makeTempDir();
  try {
    const result = await installBundle({
      parsed: parsedHuumaUi,
      cwd,
      fetch: () =>
        Promise.resolve(
          buildBundleTarball([
            { name: "mcp-builder" },
            { name: "domain-modeling" },
          ]),
        ),
      log: noopLog,
    });

    assertEquals(result.members.length, 2);
    assertEquals(
      result.members.map((m) => m.name).sort(),
      ["domain-modeling", "mcp-builder"],
    );

    for (const name of ["mcp-builder", "domain-modeling"]) {
      const skillMd = await Deno.readTextFile(
        join(cwd, ".agents", "skills", name, "SKILL.md"),
      );
      assertStringIncludes(skillMd, `name: ${name}`);
    }

    const manifest = await readManifest(join(cwd, ".agents", "skills"));
    const mcp = manifest.skills["mcp-builder"];
    assert(mcp, "mcp-builder manifest entry exists");
    assertEquals(mcp.source.owner, "huuma-studio");
    assertEquals(mcp.source.repo, "ui");
    assertEquals(mcp.source.ref, "main");
    assertEquals(mcp.source.subpath, ["skills", "mcp-builder"]);
    assertStringIncludes(mcp.contentHash, "sha256-");

    const domain = manifest.skills["domain-modeling"];
    assert(domain, "domain-modeling manifest entry exists");
    assertEquals(domain.source.subpath, ["skills", "domain-modeling"]);

    // not-a-skill/ is not installed.
    const names = await skillDirNames(join(cwd, ".agents", "skills"));
    assertEquals(names.includes("not-a-skill"), false);
    // No stray .tmp-/.old- dirs.
    assertEquals(
      names.filter((n) => n.startsWith(".tmp-") || n.startsWith(".old-"))
        .length,
      0,
    );
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("empty bundle succeeds with no members and leaves the manifest unchanged", async () => {
  const cwd = await Deno.makeTempDir();
  try {
    const result = await installBundle({
      parsed: parsedHuumaUi,
      cwd,
      // Tarball with only the not-a-skill sibling — no SKILL.md anywhere.
      fetch: () =>
        Promise.resolve(
          buildBundleTarball([]),
        ),
      log: noopLog,
    });

    assertEquals(result.members.length, 0);

    // No skill dirs created (only .manifest.json may exist, and it should not
    // because we never wrote it for an empty bundle).
    const skillsDir = join(cwd, ".agents", "skills");
    const names = await skillDirNames(skillsDir);
    assertEquals(names.filter((n) => !n.startsWith(".")).length, 0); // no skill dirs
    assertEquals(names.includes(".manifest.json"), false); // no manifest written
    // No stray temp dirs.
    assertEquals(
      names.filter((n) => n.startsWith(".tmp-") || n.startsWith(".old-"))
        .length,
      0,
    );
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("atomic abort on invalid member installs nothing and leaves no temp dirs", async () => {
  const cwd = await Deno.makeTempDir();
  try {
    const err = await assertRejects(
      () =>
        installBundle({
          parsed: parsedHuumaUi,
          cwd,
          fetch: () =>
            Promise.resolve(
              buildBundleTarball([
                { name: "mcp-builder" },
                {
                  name: "Bad_Name",
                  description: "bad member",
                },
              ]),
            ),
          log: noopLog,
        }),
      BundleValidationError,
    );
    assertStringIncludes(err.message, "Bad_Name");

    // Neither member is installed.
    const skillsDir = join(cwd, ".agents", "skills");
    const names = await skillDirNames(skillsDir);
    assertEquals(names.includes("mcp-builder"), false);
    assertEquals(names.includes("Bad_Name"), false);
    // No stray .tmp- dirs.
    assertEquals(names.filter((n) => n.startsWith(".tmp-")).length, 0);
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("compatibility warnings propagate to the member and leave others clean", async () => {
  const cwd = await Deno.makeTempDir();
  try {
    // buildBundleTarball only writes name/description frontmatter, so build a
    // custom tarball here to inject the `compatibility` field on one member.
    const longCompat = "x".repeat(501);
    const tarball = buildTarball([
      {
        path: "repo-main/skills/noisy/SKILL.md",
        content:
          `---\nname: noisy\ndescription: noisy skill\ncompatibility: ${longCompat}\n---\n# noisy\n`,
      },
      {
        path: "repo-main/skills/clean/SKILL.md",
        content: `---\nname: clean\ndescription: clean skill\n---\n# clean\n`,
      },
      { path: "repo-main/skills/not-a-skill/README.md", content: "x" },
      { path: "repo-main/README.md", content: "x" },
    ]);
    const result = await installBundle({
      parsed: parsedHuumaUi,
      cwd,
      fetch: () => Promise.resolve(tarball),
      log: noopLog,
    });

    const noisy = result.members.find((m) => m.name === "noisy");
    const clean = result.members.find((m) => m.name === "clean");
    assert(noisy, "noisy member present");
    assert(clean, "clean member present");
    assert(noisy.warnings.length > 0, "noisy member has warnings");
    assertStringIncludes(noisy.warnings[0], "compatibility");
    assertEquals(clean.warnings.length, 0, "clean member has no warnings");
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("manifest is written once with all entries sharing one installedAt", async () => {
  const cwd = await Deno.makeTempDir();
  try {
    const result = await installBundle({
      parsed: parsedHuumaUi,
      cwd,
      fetch: () =>
        Promise.resolve(
          buildBundleTarball([
            { name: "alpha" },
            { name: "beta" },
            { name: "gamma" },
          ]),
        ),
      log: noopLog,
    });
    assertEquals(result.members.length, 3);

    const manifest = await readManifest(join(cwd, ".agents", "skills"));
    const entries = Object.values(manifest.skills).filter((e) =>
      e.source.owner === "huuma-studio"
    );
    assertEquals(entries.length, 3);
    // All three share the same installedAt — one new Date() call for the bundle.
    const stamps = new Set(entries.map((e) => e.installedAt));
    assertEquals(stamps.size, 1, "all members share one installedAt timestamp");
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("each manifest entry subpath is per-member, not the bundle subpath", async () => {
  const cwd = await Deno.makeTempDir();
  try {
    await installBundle({
      parsed: parsedHuumaUi,
      cwd,
      fetch: () =>
        Promise.resolve(
          buildBundleTarball([{ name: "mcp-builder" }, {
            name: "domain-modeling",
          }]),
        ),
      log: noopLog,
    });

    const manifest = await readManifest(join(cwd, ".agents", "skills"));
    assertEquals(manifest.skills["mcp-builder"].source.subpath, [
      "skills",
      "mcp-builder",
    ]);
    assertEquals(
      manifest.skills["domain-modeling"].source.subpath,
      ["skills", "domain-modeling"],
    );
    // None of the entries use the bare bundle subpath ["skills"].
    for (const e of Object.values(manifest.skills)) {
      assertEquals(e.source.subpath.length, 2);
    }
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("path-traversal in one member aborts the whole bundle and writes nothing outside", async () => {
  const cwd = await Deno.makeTempDir();
  try {
    // With subpath ["skills"], an entry under skills/<name>/../escape.txt
    // resolves inside staging and does NOT escape. To escape staging we need
    // skills/../escape.txt, which strips to ../escape.txt and resolves outside.
    const evil = buildTarball([
      {
        path: "repo-main/skills/mcp-builder/SKILL.md",
        content: "---\nname: mcp-builder\ndescription: x\n---\n",
      },
      {
        path: "repo-main/skills/../escape.txt",
        content: "pwned",
      },
    ]);
    await assertRejects(
      () =>
        installBundle({
          parsed: parsedHuumaUi,
          cwd,
          fetch: () => Promise.resolve(evil),
          log: noopLog,
        }),
    );

    // The traversal entry (skills/../escape.txt) strips to ../escape.txt and
    // would resolve to tempRoot/escape.txt if the guard hadn't thrown. The
    // assertRejects above proves the guard fired; here we confirm no
    // escape.txt leaked anywhere under .agents/ (recursive walk — the file
    // could have landed at any level if the guard were broken).
    const escaped = await containsFileRecursive(
      join(cwd, ".agents"),
      "escape.txt",
    );
    assertEquals(
      escaped,
      false,
      "escape.txt must not exist anywhere under .agents/",
    );

    // No skill dirs installed.
    const skillsDir = join(cwd, ".agents", "skills");
    const names = await skillDirNames(skillsDir);
    assertEquals(names.includes("mcp-builder"), false);
    // No stray .tmp- dirs.
    assertEquals(names.filter((n) => n.startsWith(".tmp-")).length, 0);
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});
