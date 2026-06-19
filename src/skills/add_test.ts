import { assertEquals, assertStringIncludes } from "@std/assert";
import { TarStream } from "@std/tar/tar-stream";
import { addHelp, runAdd } from "./add.ts";
import { join } from "@std/path";

const encoder = new TextEncoder();

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

function mcpBuilderTarball(): ReadableStream<Uint8Array> {
  return buildTarball([
    {
      path: "skills-main/skills/mcp-builder/SKILL.md",
      content:
        "---\nname: mcp-builder\ndescription: mcp-builder skill\n---\n# mcp-builder\n",
    },
    {
      path: "skills-main/skills/mcp-builder/scripts/run.sh",
      content: "echo hi",
    },
    { path: "skills-main/README.md", content: "repo readme" },
  ]);
}

Deno.test("add --help returns usage containing 'huuma skills add' and '--path'", async () => {
  const out = await runAdd(["--help"]);
  assertStringIncludes(out, "huuma skills add");
  assertStringIncludes(out, "--path");
  assertStringIncludes(out, "--force");
});

Deno.test("add -h returns the same usage", async () => {
  const out = await runAdd(["-h"]);
  assertStringIncludes(out, "huuma skills add");
});

Deno.test("addHelp() returns usage text", () => {
  assertStringIncludes(addHelp(), "huuma skills add");
});

Deno.test("add with no --path sets exit code 1 and names --path", async () => {
  const errs: string[] = [];
  const out = await runAdd([], { err: (e) => errs.push(e), log: () => {} });
  assertEquals(out, "");
  assertEquals(Deno.exitCode, 1);
  assertStringIncludes(errs.join("\n"), "--path");
  Deno.exitCode = 0;
});

Deno.test("add with a bad URL renders the PathParseError and exits 1", async () => {
  const errs: string[] = [];
  await runAdd(["--path", "not-a-url"], {
    err: (e) => errs.push(e),
    log: () => {},
  });
  assertEquals(Deno.exitCode, 1);
  assertStringIncludes(errs.join("\n"), "not a valid URL");
  Deno.exitCode = 0;
});

Deno.test("add with an unknown option errors", async () => {
  const errs: string[] = [];
  await runAdd(["--bogus"], { err: (e) => errs.push(e), log: () => {} });
  assertEquals(Deno.exitCode, 1);
  assertStringIncludes(errs.join("\n"), "Unknown option");
  Deno.exitCode = 0;
});

Deno.test("add succeeds with an in-memory fetch and renders the green check", async () => {
  const cwd = await Deno.makeTempDir();
  const originalCwd = Deno.cwd();
  const logs: string[] = [];
  try {
    Deno.chdir(cwd);
    await runAdd(
      [
        "--path",
        "https://github.com/anthropics/skills/tree/main/skills/mcp-builder",
      ],
      {
        fetch: () => Promise.resolve(mcpBuilderTarball()),
        log: (l) => logs.push(l),
        err: (e) => logs.push(e),
      },
    );
    // Skill installed.
    const skillMd = await Deno.readTextFile(
      join(cwd, ".agents", "skills", "mcp-builder", "SKILL.md"),
    );
    assertStringIncludes(skillMd, "name: mcp-builder");
    // Success line contains the green check.
    assertStringIncludes(logs.join("\n"), "Installed skill 'mcp-builder'");
    assertEquals(Deno.exitCode === 1, false);
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(cwd, { recursive: true });
    Deno.exitCode = 0;
  }
});

Deno.test("add threads --force through to installSkill", async () => {
  const cwd = await Deno.makeTempDir();
  const originalCwd = Deno.cwd();
  try {
    Deno.chdir(cwd);
    // First install.
    await runAdd(
      [
        "--path",
        "https://github.com/anthropics/skills/tree/main/skills/mcp-builder",
      ],
      {
        fetch: () => Promise.resolve(mcpBuilderTarball()),
        log: () => {},
        err: () => {},
      },
    );
    // Edit the installed skill so a same-source re-add would refuse without --force.
    await Deno.writeTextFile(
      join(cwd, ".agents", "skills", "mcp-builder", "SKILL.md"),
      "---\nname: mcp-builder\ndescription: edited\n---\n# edited\n",
    );
    // Without --force: refuses.
    Deno.exitCode = 0;
    const errs: string[] = [];
    await runAdd(
      [
        "--path",
        "https://github.com/anthropics/skills/tree/main/skills/mcp-builder",
      ],
      {
        fetch: () => Promise.resolve(mcpBuilderTarball()),
        log: () => {},
        err: (e) => errs.push(e),
      },
    );
    assertEquals(Deno.exitCode, 1);
    assertStringIncludes(errs.join("\n"), "local edits");
    // With --force: succeeds.
    Deno.exitCode = 0;
    await runAdd(
      [
        "--path",
        "https://github.com/anthropics/skills/tree/main/skills/mcp-builder",
        "--force",
      ],
      {
        fetch: () => Promise.resolve(mcpBuilderTarball()),
        log: () => {},
        err: () => {},
      },
    );
    assertEquals(Deno.exitCode === 1, false);
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(cwd, { recursive: true });
    Deno.exitCode = 0;
  }
});
