import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { withFileLock } from "./file_lock.ts";
import { resolveTools } from "./tools.ts";

/** The locked edit_file tool as the agent wires it. */
function editTool() {
  const [tool] = resolveTools(["edit_file"]).tools;
  return tool;
}

Deno.test("withFileLock serializes same-path critical sections", async () => {
  let running = 0;
  let maxConcurrent = 0;
  const section = () =>
    withFileLock("/huuma-file-lock-test/serial", async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
    });
  await Promise.all([section(), section(), section()]);
  assertEquals(maxConcurrent, 1);
});

Deno.test("withFileLock keeps later sections running after a rejection", async () => {
  let ranAfterFailure = false;
  const first = withFileLock(
    "/huuma-file-lock-test/reject",
    () => Promise.reject(new Error("boom")),
  );
  const second = withFileLock("/huuma-file-lock-test/reject", async () => {
    await Promise.resolve();
    ranAfterFailure = true;
  });
  await assertRejects(() => first, Error, "boom");
  await second;
  assertEquals(ranAfterFailure, true);
});

Deno.test("withFileLock does not block different paths", async () => {
  let running = 0;
  let maxConcurrent = 0;
  const section = (name: string) =>
    withFileLock(`/huuma-file-lock-test/${name}`, async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
    });
  await Promise.all([section("a"), section("b"), section("c")]);
  assertEquals(maxConcurrent, 3);
});

// Spec #93, finding 1: two same-file search_replace calls issued in one batch
// — the first reported success but never landed (last writer wins). Both must
// apply, and the final content must contain both edits.
Deno.test("edit_file applies two same-file edits issued in one batch", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = join(dir, "page.tsx");
    await Deno.writeTextFile(file, "const a = 1;\nconst b = 2;\n");
    const edit = editTool();

    const results = await Promise.all([
      edit.call({
        path: file,
        operation: "search_replace",
        search: "const a = 1;",
        replace: "import { helper } from \"./helper.ts\";\nconst a = 1;",
      }),
      edit.call({
        path: file,
        operation: "search_replace",
        search: "const b = 2;",
        replace: "const b = 3;",
      }),
    ]);
    assertEquals(
      results.map((r) => (r as { success: boolean }).success),
      [true, true],
    );
    assertEquals(
      await Deno.readTextFile(file),
      "import { helper } from \"./helper.ts\";\nconst a = 1;\nconst b = 3;\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// Spec #93, finding 2: insert_lines landed 4 lines past the requested line —
// the size of a dropped same-batch edit. Positions must resolve against the
// content the earlier edits produced, never a stale snapshot.
Deno.test("edit_file insert_lines lands at the requested line of current content", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = join(dir, "list.tsx");
    await Deno.writeTextFile(file, "const a = 1;\nconst b = 2;\n");
    const edit = editTool();

    // Calls started together acquire the lock in issue order: the import
    // insertion first, then the line insert targeting line 5 of the file as
    // the first edit left it.
    await Promise.all([
      edit.call({
        path: file,
        operation: "search_replace",
        search: "const a = 1;",
        replace: [
          "import { SPEC_STATUS_BADGES } from \"./spec-status.ts\";",
          "import { SPEC_STATUS_LABELS } from \"./spec-status.ts\";",
          "",
          "const a = 1;",
        ].join("\n"),
      }),
      edit.call({
        path: file,
        operation: "insert_lines",
        content: "// inserted\n",
        line: 5,
      }),
    ]);

    const lines = (await Deno.readTextFile(file)).split("\n");
    assertEquals(lines[4], "// inserted");
    assertEquals(lines[5], "const b = 2;");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// Spec #93, finding 3: a same-file batch corrupted the file tail with a
// duplicated fragment. Every operation must leave the content outside its
// edited range byte-identical.
Deno.test("edit_file batch leaves content outside the edited ranges byte-identical", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = join(dir, "deno.json");
    await Deno.writeTextFile(
      file,
      "{\n  \"a\": 1,\n  \"b\": 2,\n  \"d\": 4\n}\n",
    );
    const edit = editTool();

    await Promise.all([
      edit.call({
        path: file,
        operation: "search_replace",
        search: "\"a\": 1",
        replace: "\"a\": 2",
      }),
      edit.call({
        path: file,
        operation: "delete_lines",
        lineStart: 3,
      }),
      edit.call({
        path: file,
        operation: "insert_lines",
        content: "  \"c\": 3,\n",
        line: 3,
      }),
    ]);

    const content = await Deno.readTextFile(file);
    // A single JSON value — the corrupted-tail bug produced two.
    assertEquals(JSON.parse(content), { a: 2, c: 3, d: 4 });
    assertEquals(content, "{\n  \"a\": 2,\n  \"c\": 3,\n  \"d\": 4\n}\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("edit_file surfaces per-call errors without blocking later edits", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = join(dir, "app.ts");
    await Deno.writeTextFile(file, "const a = 1;\nconst b = 2;\n");
    const edit = editTool();

    const failing = edit.call({
      path: file,
      operation: "search_replace",
      search: "NO SUCH TEXT",
      replace: "x",
    });
    const valid = edit.call({
      path: file,
      operation: "search_replace",
      search: "const b = 2;",
      replace: "const b = 3;",
    });
    await assertRejects(() => failing, Error, "Text not found");
    await valid;
    assertEquals(await Deno.readTextFile(file), "const a = 1;\nconst b = 3;\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// The whole files preset must be protected too, not just --tools edit_file.
Deno.test("files preset exposes the serialized edit_file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = join(dir, "f.txt");
    await Deno.writeTextFile(file, "one\ntwo\n");
    const tools = resolveTools(["files"]).tools;
    const edit = tools.find((t) => t.name === "edit_file")!;

    await Promise.all([
      edit.call({
        path: file,
        operation: "search_replace",
        search: "one",
        replace: "uno",
      }),
      edit.call({
        path: file,
        operation: "search_replace",
        search: "two",
        replace: "zwei",
      }),
    ]);

    // Unlocked, these two concurrent edits clobber each other's write and
    // one is lost; serialized, both land.
    assertEquals(await Deno.readTextFile(file), "uno\nzwei\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});