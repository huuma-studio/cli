const encoder = new TextEncoder();

export function write(text: string): void {
  Deno.stdout.writeSync(encoder.encode(text));
}

export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";
export const CLEAR_LINE = "\r\x1b[2K";
export const CLEAR_DOWN = "\x1b[J";

export function cursorUp(rows: number): string {
  return rows > 0 ? `\x1b[${rows}A` : "";
}

export function cursorTo(column: number): string {
  return `\x1b[${column}G`;
}

export function columns(): number {
  try {
    const { columns } = Deno.consoleSize();
    return columns > 0 ? columns : 80;
  } catch {
    return 80;
  }
}

function style(text: string, open: number, close: number): string {
  return Deno.noColor ? text : `\x1b[${open}m${text}\x1b[${close}m`;
}

export const bold = (text: string): string => style(text, 1, 22);
export const dim = (text: string): string => style(text, 2, 22);
export const red = (text: string): string => style(text, 31, 39);
export const green = (text: string): string => style(text, 32, 39);
export const cyan = (text: string): string => style(text, 36, 39);

export type KeyName =
  | "char"
  | "enter"
  | "tab"
  | "escape"
  | "backspace"
  | "delete"
  | "left"
  | "right"
  | "up"
  | "down"
  | "home"
  | "end"
  | "wordLeft"
  | "wordRight"
  | "deleteWordLeft"
  | "deleteToStart"
  | "deleteToEnd"
  | "abort"
  | "eof";

export interface Key {
  name: KeyName;
  char?: string;
}

const CONTROL_KEYS: Record<number, KeyName> = {
  1: "home", // ctrl+a
  2: "left", // ctrl+b
  3: "abort", // ctrl+c
  4: "eof", // ctrl+d
  5: "end", // ctrl+e
  6: "right", // ctrl+f
  8: "backspace", // ctrl+h
  9: "tab",
  10: "enter",
  11: "deleteToEnd", // ctrl+k
  13: "enter",
  14: "down", // ctrl+n
  16: "up", // ctrl+p
  21: "deleteToStart", // ctrl+u
  23: "deleteWordLeft", // ctrl+w
  127: "backspace",
};

const ARROW_KEYS: Record<string, KeyName> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
};

export interface ByteReader {
  read(buffer: Uint8Array): Promise<number | null>;
}

export async function* keypresses(
  reader: ByteReader = Deno.stdin,
): AsyncGenerator<Key, void> {
  const buf = new Uint8Array(1024);
  const decoder = new TextDecoder();

  while (true) {
    const byteCount = await reader.read(buf);
    if (byteCount === null) {
      yield { name: "eof" };
      return;
    }
    yield* parseChunk(buf.subarray(0, byteCount), decoder);
  }
}

function* parseChunk(
  bytes: Uint8Array,
  decoder: TextDecoder,
): Generator<Key> {
  let i = 0;

  while (i < bytes.length) {
    const byte = bytes[i];

    if (byte === 0x1b) {
      const [key, next] = parseEscapeSequence(bytes, i);
      if (key) yield key;
      i = next;
      continue;
    }

    if (byte < 0x20 || byte === 0x7f) {
      const name = CONTROL_KEYS[byte];
      if (name) yield { name };
      i++;
      continue;
    }

    let end = i + 1;
    while (
      end < bytes.length && bytes[end] >= 0x20 && bytes[end] !== 0x7f
    ) {
      end++;
    }
    for (
      const char of decoder.decode(bytes.subarray(i, end), { stream: true })
    ) {
      yield { name: "char", char };
    }
    i = end;
  }
}

function parseEscapeSequence(
  bytes: Uint8Array,
  start: number,
): [Key | undefined, number] {
  if (start + 1 >= bytes.length) {
    return [{ name: "escape" }, start + 1];
  }

  const next = bytes[start + 1];

  // CSI sequences: ESC [ <params> <final>
  if (next === 0x5b) {
    let i = start + 2;
    let params = "";
    while (i < bytes.length && bytes[i] >= 0x30 && bytes[i] <= 0x3f) {
      params += String.fromCharCode(bytes[i]);
      i++;
    }
    if (i >= bytes.length) return [undefined, i];

    const final = String.fromCharCode(bytes[i]);
    i++;

    if (final in ARROW_KEYS) {
      // "1;5" (ctrl) and "1;3" (alt) modifiers turn left/right into word moves
      if (params.includes(";")) {
        if (final === "C") return [{ name: "wordRight" }, i];
        if (final === "D") return [{ name: "wordLeft" }, i];
      }
      return [{ name: ARROW_KEYS[final] }, i];
    }
    if (final === "~") {
      if (params === "1" || params === "7") return [{ name: "home" }, i];
      if (params === "4" || params === "8") return [{ name: "end" }, i];
      if (params === "3") return [{ name: "delete" }, i];
    }
    return [undefined, i];
  }

  // SS3 sequences (application cursor mode): ESC O <final>
  if (next === 0x4f && start + 2 < bytes.length) {
    const final = String.fromCharCode(bytes[start + 2]);
    if (final in ARROW_KEYS) {
      return [{ name: ARROW_KEYS[final] }, start + 3];
    }
    return [undefined, start + 3];
  }

  if (next === 0x7f || next === 0x08) {
    return [{ name: "deleteWordLeft" }, start + 2]; // alt+backspace
  }
  if (next === 0x62) return [{ name: "wordLeft" }, start + 2]; // alt+b
  if (next === 0x66) return [{ name: "wordRight" }, start + 2]; // alt+f
  if (next === 0x1b) return [{ name: "escape" }, start + 2];

  return [undefined, start + 2];
}

export async function rawSession<T>(session: () => Promise<T>): Promise<T> {
  Deno.stdin.setRaw(true);
  try {
    return await session();
  } finally {
    Deno.stdin.setRaw(false);
    write(SHOW_CURSOR);
  }
}

export function abortExit(): never {
  Deno.stdin.setRaw(false);
  write(SHOW_CURSOR + "\n");
  Deno.exit(130);
}
