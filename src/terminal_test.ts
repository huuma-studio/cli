import { assertEquals } from "@std/assert";
import { type ByteReader, type Key, keypresses } from "./terminal.ts";

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

async function keysFrom(chunks: (string | Uint8Array)[]): Promise<string[]> {
  const keys: Key[] = [];
  for await (const key of keypresses(readerFrom(chunks))) {
    if (key.name === "eof") break;
    keys.push(key);
  }
  return keys.map((key) => key.name === "char" ? `char:${key.char}` : key.name);
}

Deno.test("parses printable characters including multibyte", async () => {
  assertEquals(await keysFrom(["aé🦀"]), ["char:a", "char:é", "char:🦀"]);
});

Deno.test("parses CR as enter and LF as newline", async () => {
  // Return sends CR; Shift+Enter (e.g. Zed) and Ctrl+J send LF.
  assertEquals(await keysFrom(["\r\n\t\x7f\x08"]), [
    "enter",
    "newline",
    "tab",
    "backspace",
    "backspace",
  ]);
});

Deno.test("parses readline control keys", async () => {
  assertEquals(await keysFrom(["\x01\x05\x15\x0b\x17"]), [
    "home",
    "end",
    "deleteToStart",
    "deleteToEnd",
    "deleteWordLeft",
  ]);
});

Deno.test("parses ctrl+c and ctrl+d", async () => {
  const keys: Key[] = [];
  for await (const key of keypresses(readerFrom(["\x03\x04"]))) {
    keys.push(key);
  }
  // the trailing eof comes from the reader closing after the input
  assertEquals(keys.map((key) => key.name), ["abort", "eof", "eof"]);
});

Deno.test("parses CSI arrow keys", async () => {
  assertEquals(await keysFrom(["\x1b[A\x1b[B\x1b[C\x1b[D"]), [
    "up",
    "down",
    "right",
    "left",
  ]);
});

Deno.test("parses CSI home, end and delete variants", async () => {
  assertEquals(
    await keysFrom(["\x1b[H\x1b[F\x1b[1~\x1b[4~\x1b[7~\x1b[8~\x1b[3~"]),
    [
      "home",
      "end",
      "home",
      "end",
      "home",
      "end",
      "delete",
    ],
  );
});

Deno.test("parses ctrl/alt modified arrows as word moves", async () => {
  assertEquals(await keysFrom(["\x1b[1;5C\x1b[1;5D\x1b[1;3C\x1b[1;3D"]), [
    "wordRight",
    "wordLeft",
    "wordRight",
    "wordLeft",
  ]);
});

Deno.test("parses SS3 sequences (application cursor mode)", async () => {
  assertEquals(await keysFrom(["\x1bOA\x1bOB\x1bOH\x1bOF"]), [
    "up",
    "down",
    "home",
    "end",
  ]);
});

Deno.test("parses alt shortcuts", async () => {
  assertEquals(await keysFrom(["\x1bb\x1bf\x1b\x7f"]), [
    "wordLeft",
    "wordRight",
    "deleteWordLeft",
  ]);
});

Deno.test("parses a bare escape at the end of a chunk", async () => {
  assertEquals(await keysFrom(["\x1b"]), ["escape"]);
});

Deno.test("ignores unknown escape sequences", async () => {
  assertEquals(await keysFrom(["\x1b[Za"]), ["char:a"]);
});

Deno.test("parses keys split across reads", async () => {
  assertEquals(await keysFrom(["ab", "\x1b[D", "c", "\r"]), [
    "char:a",
    "char:b",
    "left",
    "char:c",
    "enter",
  ]);
});

Deno.test("yields eof when the reader closes", async () => {
  const keys: Key[] = [];
  for await (const key of keypresses(readerFrom(["a"]))) {
    keys.push(key);
  }
  assertEquals(keys.map((key) => key.name), ["char", "eof"]);
});

Deno.test("parses shift+enter from the kitty keyboard protocol", async () => {
  // CSI <code> ; <modifier> u — code 13 is Enter, modifier 2 is Shift.
  assertEquals(await keysFrom(["\x1b[13;2u"]), ["newline"]);
  // Unmodified Enter reported through the protocol still submits.
  assertEquals(await keysFrom(["\x1b[13u"]), ["enter"]);
});

Deno.test("parses shift+enter from xterm modifyOtherKeys", async () => {
  // CSI 27 ; <modifier> ; <code> ~
  assertEquals(await keysFrom(["\x1b[27;2;13~"]), ["newline"]);
});

async function firstKey(chunks: (string | Uint8Array)[]): Promise<Key> {
  for await (const key of keypresses(readerFrom(chunks))) {
    return key;
  }
  throw new Error("no key produced");
}

Deno.test("collects a bracketed paste into a single key", async () => {
  const key = await firstKey(["\x1b[200~a\tb\nc\x1b[201~"]);
  assertEquals(key.name, "paste");
  assertEquals(key.text, "a\tb\nc");
});

Deno.test("reassembles a bracketed paste split across reads", async () => {
  const key = await firstKey(["\x1b[200~foo\n", "bar", "\x1b[201~"]);
  assertEquals(key.name, "paste");
  assertEquals(key.text, "foo\nbar");
});

Deno.test("reassembles a paste when the end marker is split", async () => {
  // The closing marker is itself torn across two reads.
  const key = await firstKey(["\x1b[200~hi\x1b[20", "1~"]);
  assertEquals(key.name, "paste");
  assertEquals(key.text, "hi");
});

Deno.test("normalizes CRLF newlines inside a bracketed paste", async () => {
  const key = await firstKey(["\x1b[200~a\r\nb\rc\x1b[201~"]);
  assertEquals(key.text, "a\nb\nc");
});

Deno.test("reassembles an escape sequence split across reads", async () => {
  assertEquals(await keysFrom(["\x1b", "[", "D"]), ["left"]);
});
