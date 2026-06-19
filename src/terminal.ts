const encoder = new TextEncoder();

export function write(text: string): void {
  Deno.stdout.writeSync(encoder.encode(text));
}

export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";
export const CLEAR_LINE = "\r\x1b[2K";
export const CLEAR_DOWN = "\x1b[J";

// Opt-in input modes for richer editing. Unsupported terminals ignore the
// sequences, so writing them is always safe.
//
// Bracketed paste wraps pasted text in markers so newlines in a paste can be
// told apart from a typed Enter. The kitty keyboard protocol's "disambiguate"
// flag makes the terminal report Shift+Enter distinctly from Enter; it is
// pushed on entry and popped on exit so other prompts are unaffected.
export const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
export const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";
export const ENABLE_RICH_KEYS = "\x1b[>1u";
export const DISABLE_RICH_KEYS = "\x1b[<1u";

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
export const yellow = (text: string): string => style(text, 33, 39);
export const cyan = (text: string): string => style(text, 36, 39);

export type KeyName =
  | "char"
  | "enter"
  | "newline"
  | "paste"
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
  /** The decoded character for a `char` key. */
  char?: string;
  /** The pasted text for a `paste` key (newlines normalized to "\n"). */
  text?: string;
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
  10: "newline", // ctrl+j / LF — also Shift+Enter in some terminals (e.g. Zed)
  11: "deleteToEnd", // ctrl+k
  13: "enter", // CR — Return
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

const PASTE_END = encoder.encode("\x1b[201~");

/**
 * Decodes a byte stream into key events. Parser state persists across reads, so
 * an escape sequence or bracketed paste split over a read boundary is
 * reassembled rather than dropped. A whole bracketed paste surfaces as one
 * `paste` key whose `text` holds the content, newlines normalized to "\n".
 */
export async function* keypresses(
  reader: ByteReader = Deno.stdin,
): AsyncGenerator<Key, void> {
  const decoder = new TextDecoder();
  const readBuf = new Uint8Array(1024);
  let pending: Uint8Array = new Uint8Array(0);
  let inPaste = false;
  let pasteText = "";

  while (true) {
    const byteCount = await reader.read(readBuf);
    const atEof = byteCount === null;
    if (!atEof) pending = concat(pending, readBuf.subarray(0, byteCount));

    let i = 0;
    while (i < pending.length) {
      if (inPaste) {
        const end = indexOf(pending, PASTE_END, i);
        if (end !== -1) {
          pasteText += decoder.decode(pending.subarray(i, end));
          yield { name: "paste", text: pasteText.replace(/\r\n?/g, "\n") };
          pasteText = "";
          inPaste = false;
          i = end + PASTE_END.length;
          continue;
        }
        // No closing marker yet — take everything but a possible partial marker.
        const keep = atEof
          ? pending.length
          : Math.max(i, pending.length - tailPrefix(pending, PASTE_END));
        pasteText += decoder.decode(pending.subarray(i, keep), {
          stream: !atEof,
        });
        i = keep;
        if (!atEof) break; // wait for the rest of the paste
        yield { name: "paste", text: pasteText.replace(/\r\n?/g, "\n") };
        pasteText = "";
        inPaste = false;
        continue;
      }

      const byte = pending[i];
      if (byte === 0x1b) {
        const token = parseEscape(pending, i, atEof);
        if (token.incomplete) break; // hold the bytes; retry after the next read
        if (token.pasteStart) inPaste = true;
        else if (token.key) yield token.key;
        i = token.next;
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
        end < pending.length && pending[end] >= 0x20 && pending[end] !== 0x7f
      ) {
        end++;
      }
      for (
        const char of decoder.decode(pending.subarray(i, end), { stream: true })
      ) {
        yield { name: "char", char };
      }
      i = end;
    }

    pending = pending.subarray(i);
    if (atEof) {
      yield { name: "eof" };
      return;
    }
  }
}

interface EscapeToken {
  key?: Key;
  pasteStart?: boolean;
  incomplete?: boolean; // not enough bytes yet to decide — wait for more
  next: number;
}

function parseEscape(
  bytes: Uint8Array,
  start: number,
  atEof: boolean,
): EscapeToken {
  if (start + 1 >= bytes.length) {
    return atEof
      ? { key: { name: "escape" }, next: start + 1 }
      : { incomplete: true, next: start };
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
    if (i >= bytes.length) {
      return atEof ? { next: i } : { incomplete: true, next: start };
    }

    const final = String.fromCharCode(bytes[i]);
    i++;

    if (final === "~" && params === "200") return { pasteStart: true, next: i };
    if (final in ARROW_KEYS) {
      // "1;5" (ctrl) and "1;3" (alt) modifiers turn left/right into word moves
      if (params.includes(";")) {
        if (final === "C") return { key: { name: "wordRight" }, next: i };
        if (final === "D") return { key: { name: "wordLeft" }, next: i };
      }
      return { key: { name: ARROW_KEYS[final] }, next: i };
    }
    if (final === "~") {
      if (params === "1" || params === "7") {
        return { key: { name: "home" }, next: i };
      }
      if (params === "4" || params === "8") {
        return { key: { name: "end" }, next: i };
      }
      if (params === "3") return { key: { name: "delete" }, next: i };
      // xterm modifyOtherKeys: ESC [ 27 ; <mod> ; <code> ~
      const parts = params.split(";");
      if (parts[0] === "27") {
        const key = modifiedKey(parts[2], parts[1]);
        if (key) return { key, next: i };
      }
      return { next: i };
    }
    if (final === "u") {
      // kitty keyboard protocol: ESC [ <code> ; <mod> u
      const parts = params.split(";");
      const key = modifiedKey(parts[0], parts[1]);
      if (key) return { key, next: i };
      return { next: i };
    }
    return { next: i };
  }

  // SS3 sequences (application cursor mode): ESC O <final>
  if (next === 0x4f) {
    if (start + 2 >= bytes.length) {
      return atEof ? { next: start + 2 } : { incomplete: true, next: start };
    }
    const final = String.fromCharCode(bytes[start + 2]);
    if (final in ARROW_KEYS) {
      return { key: { name: ARROW_KEYS[final] }, next: start + 3 };
    }
    return { next: start + 3 };
  }

  if (next === 0x7f || next === 0x08) {
    return { key: { name: "deleteWordLeft" }, next: start + 2 }; // alt+backspace
  }
  if (next === 0x62) return { key: { name: "wordLeft" }, next: start + 2 }; // alt+b
  if (next === 0x66) return { key: { name: "wordRight" }, next: start + 2 }; // alt+f
  if (next === 0x1b) return { key: { name: "escape" }, next: start + 2 };

  return { next: start + 2 };
}

/**
 * Maps an enhanced-keyboard keycode (kitty or modifyOtherKeys) and its modifier
 * to a key. Only the keys editing needs are recognized; Shift+Enter becomes
 * `newline` so it reads as a line break instead of a submit. The modifier is
 * 1 + a bitmask whose lowest bit is Shift.
 */
function modifiedKey(
  codeText: string | undefined,
  modText: string | undefined,
): Key | undefined {
  const shift = ((Number.parseInt(modText ?? "1", 10) - 1) & 1) === 1;
  switch (Number.parseInt(codeText ?? "", 10)) {
    case 13:
      return { name: shift ? "newline" : "enter" };
    case 9:
      return { name: "tab" };
    case 27:
      return { name: "escape" };
    case 127:
      return { name: "backspace" };
    default:
      return undefined;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function indexOf(
  haystack: Uint8Array,
  needle: Uint8Array,
  from: number,
): number {
  for (let i = from; i + needle.length <= haystack.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

// Length of the longest suffix of `bytes` that is a proper prefix of `marker` —
// a partial marker that may complete on the next read.
function tailPrefix(bytes: Uint8Array, marker: Uint8Array): number {
  const max = Math.min(bytes.length, marker.length - 1);
  for (let len = max; len > 0; len--) {
    let match = true;
    for (let j = 0; j < len; j++) {
      if (bytes[bytes.length - len + j] !== marker[j]) {
        match = false;
        break;
      }
    }
    if (match) return len;
  }
  return 0;
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
