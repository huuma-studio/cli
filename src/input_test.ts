import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { choose, confirm, LineReader, multiline, question } from "./input.ts";
import type { ByteReader } from "./terminal.ts";

function readerFrom(chunks: (string | Uint8Array)[]): ByteReader {
  const encoder = new TextEncoder();
  const queue = chunks.map((chunk) =>
    typeof chunk === "string" ? encoder.encode(chunk) : chunk
  );

  return {
    read(buffer: Uint8Array): Promise<number | null> {
      const chunk = queue.shift();
      if (!chunk) return Promise.resolve(null);
      buffer.set(chunk);
      return Promise.resolve(chunk.length);
    },
  };
}

Deno.test("LineReader splits multiple lines from one chunk", async () => {
  const lines = new LineReader(readerFrom(["a\nb\nc\n"]));
  assertEquals(await lines.readLine(), "a");
  assertEquals(await lines.readLine(), "b");
  assertEquals(await lines.readLine(), "c");
  assertEquals(await lines.readLine(), null);
});

Deno.test("LineReader joins a line split across chunks", async () => {
  const lines = new LineReader(readerFrom(["ab", "c\n"]));
  assertEquals(await lines.readLine(), "abc");
});

Deno.test("LineReader returns a trailing line without newline on close", async () => {
  const lines = new LineReader(readerFrom(["abc"]));
  assertEquals(await lines.readLine(), "abc");
  assertEquals(await lines.readLine(), null);
});

Deno.test("LineReader trims carriage returns and whitespace", async () => {
  const lines = new LineReader(readerFrom(["  win\r\n"]));
  assertEquals(await lines.readLine(), "win");
});

interface PromptRun<T> {
  result: T;
  output: string;
}

interface MutableStdio {
  stdin: {
    read(buffer: Uint8Array): Promise<number | null>;
    isTerminal(): boolean;
    setRaw(mode: boolean): void;
  };
  stdout: {
    writeSync(data: Uint8Array): number;
  };
}

/**
 * Runs a prompt with stdin replaced by scripted keystrokes and stdout
 * captured, so the interactive code paths run without a real terminal.
 */
async function runPrompt<T>(
  chunks: (string | Uint8Array)[],
  prompt: () => Promise<T>,
): Promise<PromptRun<T>> {
  const reader = readerFrom(chunks);
  const decoder = new TextDecoder();
  let output = "";

  const { stdin, stdout } = Deno as unknown as MutableStdio;
  const original = {
    read: stdin.read,
    isTerminal: stdin.isTerminal,
    setRaw: stdin.setRaw,
    writeSync: stdout.writeSync,
  };

  stdin.read = (buffer) => reader.read(buffer);
  stdin.isTerminal = () => true;
  stdin.setRaw = () => {};
  stdout.writeSync = (data) => {
    output += decoder.decode(data);
    return data.length;
  };

  try {
    const result = await prompt();
    return { result, output };
  } finally {
    stdin.read = original.read;
    stdin.isTerminal = original.isTerminal;
    stdin.setRaw = original.setRaw;
    stdout.writeSync = original.writeSync;
  }
}

Deno.test("question inserts at the cursor after arrow navigation", async () => {
  const { result } = await runPrompt(
    ["helo\x1b[Dl\r"],
    () => question("Name:"),
  );
  assertEquals(result, "hello");
});

Deno.test("question edits with home and end", async () => {
  const { result } = await runPrompt(
    ["bc\x01a\x05d\r"],
    () => question("Name:"),
  );
  assertEquals(result, "abcd");
});

Deno.test("question deletes forward at the cursor", async () => {
  const { result } = await runPrompt(
    ["abc\x1b[D\x1b[3~\r"],
    () => question("Name:"),
  );
  assertEquals(result, "ab");
});

Deno.test("question deletes the previous word with ctrl+w", async () => {
  const { result } = await runPrompt(
    ["foo bar\x17baz\r"],
    () => question("Name:"),
  );
  assertEquals(result, "foo baz");
});

Deno.test("question clears to start with ctrl+u", async () => {
  const { result } = await runPrompt(
    ["abc\x15xyz\r"],
    () => question("Name:"),
  );
  assertEquals(result, "xyz");
});

Deno.test("question re-prompts on validation error", async () => {
  const { result, output } = await runPrompt(
    ["\r", "app\r"],
    () =>
      question("Name:", {
        validate: (value) => value ? undefined : "Name is required",
      }),
  );
  assertEquals(result, "app");
  assertStringIncludes(output, "Name is required");
});

Deno.test("question accepts the default value with enter", async () => {
  const { result, output } = await runPrompt(
    ["\r"],
    () => question("Language:", { default: "ts" }),
  );
  assertEquals(result, "ts");
  assertStringIncludes(output, "(ts)");
});

Deno.test("question submits on a line feed", async () => {
  // A bare LF (ctrl+j, or Shift+Enter on terminals like Zed) submits, like Enter.
  const { result } = await runPrompt(["hi\n"], () => question("Name:"));
  assertEquals(result, "hi");
});

Deno.test("confirm answers on a single keypress", async () => {
  assertEquals((await runPrompt(["y"], () => confirm("Ok?"))).result, true);
  assertEquals(
    (await runPrompt(["N"], () => confirm("Ok?", true))).result,
    false,
  );
});

Deno.test("confirm takes the default on enter", async () => {
  assertEquals(
    (await runPrompt(["\r"], () => confirm("Ok?", true))).result,
    true,
  );
  assertEquals((await runPrompt(["\r"], () => confirm("Ok?"))).result, false);
});

Deno.test("confirm ignores invalid keys", async () => {
  const { result } = await runPrompt(["x7\x1b[Ay"], () => confirm("Ok?"));
  assertEquals(result, true);
});

Deno.test("confirm answers on a line feed", async () => {
  // LF (ctrl+j / Shift+Enter) takes the default, like Enter.
  const { result } = await runPrompt(["\n"], () => confirm("Ok?", true));
  assertEquals(result, true);
});

Deno.test("choose selects with arrow keys", async () => {
  const { result, output } = await runPrompt(
    ["\x1b[B\r"],
    () => choose(["website", "api"], "Type:"),
  );
  assertEquals(result, "api");
  assertStringIncludes(output, "website");
});

Deno.test("choose wraps around at the ends", async () => {
  const up = await runPrompt(["\x1b[A\r"], () => choose(["a", "b", "c"]));
  assertEquals(up.result, "c");
  const down = await runPrompt(
    ["\x1b[B\x1b[B\x1b[B\r"],
    () => choose(["a", "b", "c"]),
  );
  assertEquals(down.result, "a");
});

Deno.test("choose supports number shortcuts and j/k", async () => {
  const digit = await runPrompt(["2\r"], () => choose(["a", "b", "c"]));
  assertEquals(digit.result, "b");
  const vim = await runPrompt(["jjk\r"], () => choose(["a", "b", "c"]));
  assertEquals(vim.result, "b");
});

Deno.test("choose renders option descriptions", async () => {
  const { result, output } = await runPrompt(
    ["\r"],
    () =>
      choose(
        [{ label: "website", description: "A website project" }],
        "Type:",
      ),
  );
  assertEquals(result, "website");
  assertStringIncludes(output, "A website project");
});

Deno.test("choose rejects an empty option list", async () => {
  await assertRejects(() => choose([]), Error, "No options");
});

Deno.test("choose selects on a line feed", async () => {
  // LF (ctrl+j / Shift+Enter) selects the active item, like Enter.
  const { result } = await runPrompt(["\n"], () => choose(["a", "b"]));
  assertEquals(result, "a");
});

class ExitSentinel extends Error {}

Deno.test("question exits with code 130 on ctrl+c", async () => {
  const originalExit = Deno.exit;
  let code: number | undefined;
  Deno.exit = ((exitCode?: number) => {
    code = exitCode;
    throw new ExitSentinel();
  }) as typeof Deno.exit;

  try {
    await assertRejects(
      () => runPrompt(["ab\x03"], () => question("Name:")),
      ExitSentinel,
    );
    assertEquals(code, 130);
  } finally {
    Deno.exit = originalExit;
  }
});

Deno.test("prompts fall back to line input when stdin is not a tty", async () => {
  const fixture = new URL("./testdata/prompt_fixture.ts", import.meta.url);
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--quiet", fixture.pathname],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();

  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode("my-app\nyes\n2\n"));
  await writer.close();

  const { code, stdout } = await child.output();
  assertEquals(code, 0);

  const lines = new TextDecoder().decode(stdout).trim().split("\n");
  assertEquals(JSON.parse(lines.at(-1)!), {
    name: "my-app",
    ok: true,
    type: "api",
  });
});

Deno.test("non-tty prompts fail fast when stdin closes early", async () => {
  const fixture = new URL("./testdata/prompt_fixture.ts", import.meta.url);
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--quiet", fixture.pathname],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();

  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode("app\n"));
  await writer.close();

  const { code, stderr } = await child.output();
  assertEquals(code, 1);
  assertStringIncludes(new TextDecoder().decode(stderr), "stdin closed");
});

Deno.test("multiline submits on enter", async () => {
  const { result } = await runPrompt(
    ["hello\r"],
    () => multiline("Notes:"),
  );
  assertEquals(result, "hello");
});

Deno.test("multiline inserts a new line on shift+enter", async () => {
  // \x1b[13;2u is Shift+Enter as reported by the kitty keyboard protocol;
  // the trailing \r (Enter) submits.
  const { result } = await runPrompt(
    ["first\x1b[13;2usecond\r"],
    () => multiline("Notes:"),
  );
  assertEquals(result, "first\nsecond");
});

Deno.test("multiline treats a line feed as a new line (Zed shift+enter)", async () => {
  // Zed sends LF (\n) for Shift+Enter and CR (\r) for Enter; Ctrl+J also sends
  // LF. The trailing CR submits.
  const { result } = await runPrompt(
    ["first\nsecond\r"],
    () => multiline("Notes:"),
  );
  assertEquals(result, "first\nsecond");
});

Deno.test("multiline also submits on ctrl+d", async () => {
  const { result } = await runPrompt(
    ["bye\x04"],
    () => multiline("Notes:"),
  );
  assertEquals(result, "bye");
});

Deno.test("multiline keeps tabs and newlines from a pasted block", async () => {
  const block = [
    "Architecture\tMixture-of-Experts (MoE)",
    "Total Parameters\t1T",
    "Activated Parameters\t32B",
    "Number of Layers (Dense layer included)\t61",
    "Number of Dense Layers\t1",
    "Attention Hidden Dimension\t7168",
    "MoE Hidden Dimension (per Expert)\t2048",
    "Number of Attention Heads\t64",
    "Number of Experts\t384",
    "Selected Experts per Token\t8",
    "Number of Shared Experts\t1",
    "Vocabulary Size\t160K",
    "Context Length\t256K",
    "Attention Mechanism\tMLA",
    "Activation Function\tSwiGLU",
    "Vision Encoder\tMoonViT",
    "Parameters of Vision Encoder\t400M",
  ].join("\n");

  // Bracketed paste delivers the block verbatim — its newlines do not submit —
  // and the trailing Enter sends it.
  const { result, output } = await runPrompt(
    ["\x1b[200~" + block + "\x1b[201~\r"],
    () => multiline("Paste the spec:"),
  );
  assertEquals(result, block);
  assertStringIncludes(output, "shift+enter");
});

Deno.test("multiline merges lines when backspacing at column zero", async () => {
  // Shift+Enter splits "ab"/"cd"; home (\x01) then backspace (\x7f) rejoins them.
  const { result } = await runPrompt(
    ["ab\x1b[13;2ucd\x01\x7f\r"],
    () => multiline("Notes:"),
  );
  assertEquals(result, "abcd");
});

Deno.test("multiline edits a previous line after moving up", async () => {
  // up (\x1b[A) returns to "foo", clamping the column to its end before inserting.
  const { result } = await runPrompt(
    ["foo\x1b[13;2ubar\x1b[A!\r"],
    () => multiline("Notes:"),
  );
  assertEquals(result, "foo!\nbar");
});

Deno.test("multiline re-prompts on validation error", async () => {
  const { result, output } = await runPrompt(
    ["\r", "hi\r"],
    () =>
      multiline("Notes:", {
        validate: (value) => value ? undefined : "Notes are required",
      }),
  );
  assertEquals(result, "hi");
  assertStringIncludes(output, "Notes are required");
});

Deno.test("multiline rejects an unsatisfied validator when stdin closes", async () => {
  // Ctrl+D (\x04) on an empty buffer, then the stream ends: the validator's
  // message surfaces instead of submitting the empty value, matching the
  // non-terminal path.
  await assertRejects(
    () =>
      runPrompt(
        ["\x04"],
        () =>
          multiline("Notes:", {
            validate: (value) => value ? undefined : "Notes are required",
          }),
      ),
    Error,
    "Notes are required (stdin closed)",
  );
});

Deno.test("multiline exits with code 130 on ctrl+c", async () => {
  const originalExit = Deno.exit;
  let code: number | undefined;
  Deno.exit = ((exitCode?: number) => {
    code = exitCode;
    throw new ExitSentinel();
  }) as typeof Deno.exit;

  try {
    await assertRejects(
      () => runPrompt(["ab\x03"], () => multiline("Notes:")),
      ExitSentinel,
    );
    assertEquals(code, 130);
  } finally {
    Deno.exit = originalExit;
  }
});

Deno.test("multiline reads piped input until stdin closes", async () => {
  const fixture = new URL("./testdata/multiline_fixture.ts", import.meta.url);
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--quiet", fixture.pathname],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();

  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode("line1\nline2\n"));
  await writer.close();

  const { code, stdout } = await child.output();
  assertEquals(code, 0);

  const lines = new TextDecoder().decode(stdout).trim().split("\n");
  assertEquals(JSON.parse(lines.at(-1)!), { text: "line1\nline2" });
});
