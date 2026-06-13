import {
  abortExit,
  bold,
  type ByteReader,
  CLEAR_DOWN,
  CLEAR_LINE,
  columns,
  cursorTo,
  cursorUp,
  cyan,
  dim,
  DISABLE_BRACKETED_PASTE,
  DISABLE_RICH_KEYS,
  ENABLE_BRACKETED_PASTE,
  ENABLE_RICH_KEYS,
  green,
  HIDE_CURSOR,
  keypresses,
  rawSession,
  red,
  write,
} from "./terminal.ts";

const QUESTION_MARK = cyan("?");
const CHECK_MARK = green("✔");
const CROSS_MARK = red("✖");
const POINTER = cyan("❯");

/**
 * Buffered line reader. Input after a newline is kept for subsequent
 * calls. `readLine` returns `null` once the reader is closed and drained.
 */
export class LineReader {
  #decoder = new TextDecoder();
  #buffer = "";
  #closed = false;
  #reader: ByteReader;

  constructor(reader: ByteReader = Deno.stdin) {
    this.#reader = reader;
  }

  async readLine(): Promise<string | null> {
    const buf = new Uint8Array(1024);

    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline !== -1) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        return line.trim();
      }

      if (this.#closed) {
        if (this.#buffer === "") return null;
        const line = this.#buffer;
        this.#buffer = "";
        return line.trim();
      }

      const byteCount = await this.#reader.read(buf);
      if (byteCount === null) {
        this.#closed = true;
        continue;
      }
      this.#buffer += this.#decoder.decode(buf.subarray(0, byteCount), {
        stream: true,
      });
    }
  }
}

const stdinLines = new LineReader();

export function readLine(): Promise<string | null> {
  return stdinLines.readLine();
}

export interface QuestionOptions {
  default?: string;
  validate?: (value: string) => string | undefined;
}

/** Multi-line input shares `question`'s validation, but a default block makes
 * little sense for a paste target, so only `validate` is carried over. */
export type MultilineOptions = Pick<QuestionOptions, "validate">;

export async function question(
  q: string,
  options: QuestionOptions = {},
): Promise<string> {
  if (!Deno.stdin.isTerminal()) {
    console.log(q);
    const line = await readLine();
    const value = line || options.default || "";
    const error = options.validate?.(value);
    if (error) {
      if (line === null) {
        throw new Error(`${error} (stdin closed)`);
      }
      console.error(`\n${error}\n`);
      return question(q, options);
    }
    return value;
  }

  return await rawSession(async () => {
    const chars: string[] = [];
    let cursor = 0;
    let error = "";

    const plainPrefix = `? ${q} `;
    const prefix = `${QUESTION_MARK} ${bold(q)} `;

    const render = () => {
      const available = Math.max(columns() - plainPrefix.length - 2, 1);
      let visibleStart = 0;
      if (chars.length > available) {
        visibleStart = Math.min(
          Math.max(cursor - available + 1, 0),
          chars.length - available,
        );
      }
      const visible = chars
        .slice(visibleStart, visibleStart + available)
        .join("");
      const hint = chars.length === 0 && options.default
        ? dim(`(${options.default})`)
        : "";

      write(CLEAR_LINE + prefix + visible + hint);
      write(`\n\x1b[2K${error ? `${CROSS_MARK} ${red(error)}` : ""}`);
      write(
        cursorUp(1) +
          cursorTo(plainPrefix.length + (cursor - visibleStart) + 1),
      );
    };

    const submit = (): string | undefined => {
      const value = (chars.join("") || options.default || "").trim();
      const message = options.validate?.(value);
      if (message) {
        error = message;
        render();
        return undefined;
      }
      write("\n\x1b[2K" + cursorUp(1));
      write(CLEAR_LINE + `${CHECK_MARK} ${bold(q)} ${cyan(value)}\n`);
      return value;
    };

    render();

    for await (const key of keypresses()) {
      if (key.name === "abort" || key.name === "eof") {
        abortExit();
      }
      if (key.name === "enter") {
        const value = submit();
        if (value !== undefined) return value;
        continue;
      }

      error = "";
      switch (key.name) {
        case "char":
          chars.splice(cursor, 0, key.char ?? "");
          cursor++;
          break;
        case "backspace":
          if (cursor > 0) {
            chars.splice(cursor - 1, 1);
            cursor--;
          }
          break;
        case "delete":
          if (cursor < chars.length) chars.splice(cursor, 1);
          break;
        case "left":
          if (cursor > 0) cursor--;
          break;
        case "right":
          if (cursor < chars.length) cursor++;
          break;
        case "home":
          cursor = 0;
          break;
        case "end":
          cursor = chars.length;
          break;
        case "wordLeft":
          cursor = wordLeft(chars, cursor);
          break;
        case "wordRight":
          cursor = wordRight(chars, cursor);
          break;
        case "deleteWordLeft": {
          const to = wordLeft(chars, cursor);
          chars.splice(to, cursor - to);
          cursor = to;
          break;
        }
        case "deleteToStart":
          chars.splice(0, cursor);
          cursor = 0;
          break;
        case "deleteToEnd":
          chars.splice(cursor);
          break;
      }
      render();
    }

    return (chars.join("") || options.default || "").trim();
  });
}

export async function confirm(
  q: string,
  defaultValue: boolean = false,
): Promise<boolean> {
  const hint = defaultValue ? "Y/n" : "y/N";

  if (!Deno.stdin.isTerminal()) {
    console.log(`${q} (${hint})`);
    const line = await readLine();
    const input = line?.toLowerCase() ?? "";

    if (line === null || input === "") return defaultValue;
    if (input === "y" || input === "yes") return true;
    if (input === "n" || input === "no") return false;

    console.error(`\n"${input}" is not a valid value!\n`);
    return confirm(q, defaultValue);
  }

  return await rawSession(async () => {
    write(
      HIDE_CURSOR + CLEAR_LINE +
        `${QUESTION_MARK} ${bold(q)} ${dim(`(${hint})`)}`,
    );

    for await (const key of keypresses()) {
      if (key.name === "abort" || key.name === "eof") {
        abortExit();
      }

      let result: boolean | undefined;
      if (key.name === "enter") {
        result = defaultValue;
      } else if (key.name === "char") {
        const char = key.char?.toLowerCase();
        if (char === "y") result = true;
        else if (char === "n") result = false;
      }

      if (result !== undefined) {
        write(
          CLEAR_LINE +
            `${CHECK_MARK} ${bold(q)} ${cyan(result ? "yes" : "no")}\n`,
        );
        return result;
      }
    }

    return defaultValue;
  });
}

export interface ChooseOption {
  label: string;
  description?: string;
}

export async function choose(
  options: (string | ChooseOption)[],
  message = "Select an option:",
): Promise<string> {
  const items: ChooseOption[] = options.map((option) =>
    typeof option === "string" ? { label: option } : option
  );

  if (items.length === 0) {
    throw new Error("No options to choose from");
  }

  if (!Deno.stdin.isTerminal()) {
    console.log(message);
    items.forEach((item, index) => {
      console.log(`${index + 1} - ${item.label}`);
    });
    const line = await readLine();
    if (line === null) {
      throw new Error("No selection made (stdin closed)");
    }
    const input = Number.parseInt(line, 10);

    if (Number.isInteger(input) && items[input - 1]) {
      return items[input - 1].label;
    }

    console.error(`\n"${input}" is not a valid value!\n`);
    return choose(options, message);
  }

  return await rawSession(async () => {
    const labelWidth = Math.max(...items.map((item) => [...item.label].length));
    let index = 0;
    let rendered = false;

    const render = () => {
      const lines = items.map((item, i) => {
        const active = i === index;
        const label = item.label.padEnd(labelWidth);
        const description = item.description
          ? `  ${dim(item.description)}`
          : "";
        return `\x1b[2K${
          active ? `${POINTER} ${cyan(label)}` : `  ${label}`
        }${description}`;
      });
      write(
        (rendered ? "\r" + cursorUp(items.length - 1) : "") + lines.join("\n"),
      );
      rendered = true;
    };

    write(
      HIDE_CURSOR + CLEAR_LINE + `${QUESTION_MARK} ${bold(message)}\n`,
    );
    render();

    for await (const key of keypresses()) {
      if (key.name === "abort" || key.name === "eof") {
        abortExit();
      }
      if (key.name === "enter") {
        write("\r" + cursorUp(items.length) + CLEAR_DOWN);
        write(
          `${CHECK_MARK} ${bold(message)} ${cyan(items[index].label)}\n`,
        );
        return items[index].label;
      }

      if (key.name === "up") {
        index = (index - 1 + items.length) % items.length;
      } else if (key.name === "down") {
        index = (index + 1) % items.length;
      } else if (key.name === "home") {
        index = 0;
      } else if (key.name === "end") {
        index = items.length - 1;
      } else if (key.name === "char") {
        if (key.char === "k") {
          index = (index - 1 + items.length) % items.length;
        } else if (key.char === "j") {
          index = (index + 1) % items.length;
        } else {
          const digit = Number.parseInt(key.char ?? "", 10);
          if (Number.isInteger(digit) && items[digit - 1]) {
            index = digit - 1;
          } else {
            continue;
          }
        }
      } else {
        continue;
      }
      render();
    }

    return items[index].label;
  });
}

const SUBMIT_HINT = "enter to submit, shift+enter for a new line";

/**
 * Reads free-form, multi-line text. `Enter` submits; a line break comes from
 * `Shift+Enter` (terminals send it as a line feed — e.g. Zed — or via the kitty
 * keyboard protocol) or from `Ctrl+J`; `ctrl+d` also submits. Pasted blocks
 * arrive through bracketed paste, so their tabs and newlines are kept verbatim
 * instead of submitting. Off a terminal it reads stdin until it closes,
 * mirroring the submit marker.
 */
export async function multiline(
  q: string,
  options: MultilineOptions = {},
): Promise<string> {
  if (!Deno.stdin.isTerminal()) {
    console.log(q);
    const collected: string[] = [];
    while (true) {
      const line = await readLine();
      if (line === null) break;
      collected.push(line);
    }
    const value = collected.join("\n").trim();
    const error = options.validate?.(value);
    if (error) throw new Error(`${error} (stdin closed)`);
    return value;
  }

  return await rawSession(async () => {
    // Each line is an array of code points, matching `question`'s buffer model.
    const lines: string[][] = [[]];
    let row = 0;
    let col = 0;
    let error = "";

    const prefix = `${QUESTION_MARK} ${bold(q)} ${dim(`(${SUBMIT_HINT})`)}`;
    // Terminal rows the cursor sat below the header after the last render, so
    // the next render can climb back to the header before clearing downward.
    let lastCursorRow = 0;

    const render = () => {
      const rows = [prefix, ...lines.map((line) => line.join(""))];
      if (error) rows.push(`${CROSS_MARK} ${red(error)}`);

      const targetRow = row + 1; // the header occupies row 0
      write("\r" + cursorUp(lastCursorRow) + CLEAR_DOWN);
      write(rows.join("\n"));
      // Climb from the last written row up to the cursor's line and column.
      write(cursorUp(rows.length - 1 - targetRow) + cursorTo(col + 1));
      lastCursorRow = targetRow;
    };

    const value = () => lines.map((line) => line.join("")).join("\n").trim();

    const submit = (): string | undefined => {
      const text = value();
      const message = options.validate?.(text);
      if (message) {
        error = message;
        render();
        return undefined;
      }
      write("\r" + cursorUp(lastCursorRow) + CLEAR_DOWN);
      write(`${CHECK_MARK} ${bold(q)}\n`);
      if (text) write(`${cyan(text)}\n`);
      return text;
    };

    // Inserts a line break: the current line splits at the cursor.
    const lineBreak = () => {
      const tail = lines[row].splice(col);
      lines.splice(row + 1, 0, tail);
      row++;
      col = 0;
    };

    // Inserts text (possibly multi-line) at the cursor, splitting on newlines.
    const insert = (text: string) => {
      const segments = text.split("\n").map((segment) => [...segment]);
      const tail = lines[row].splice(col);
      lines[row].push(...segments[0]);
      if (segments.length === 1) {
        col = lines[row].length;
        lines[row].push(...tail);
        return;
      }
      const rest = segments.slice(1);
      const last = rest[rest.length - 1];
      col = last.length;
      last.push(...tail);
      lines.splice(row + 1, 0, ...rest);
      row += rest.length;
    };

    write(ENABLE_BRACKETED_PASTE + ENABLE_RICH_KEYS);
    const restore = () => write(DISABLE_RICH_KEYS + DISABLE_BRACKETED_PASTE);

    try {
      render();

      for await (const key of keypresses()) {
        if (key.name === "abort") {
          restore();
          abortExit();
        }
        if (key.name === "enter" || key.name === "eof") {
          const submitted = submit();
          if (submitted !== undefined) return submitted;
          continue;
        }

        error = "";
        const line = lines[row];
        switch (key.name) {
          case "char":
            line.splice(col, 0, key.char ?? "");
            col++;
            break;
          case "tab":
            line.splice(col, 0, "\t");
            col++;
            break;
          case "newline":
            lineBreak();
            break;
          case "paste":
            insert(key.text ?? "");
            break;
          case "backspace":
            if (col > 0) {
              line.splice(col - 1, 1);
              col--;
            } else if (row > 0) {
              const removed = lines.splice(row, 1)[0];
              row--;
              col = lines[row].length;
              lines[row].push(...removed);
            }
            break;
          case "delete":
            if (col < line.length) {
              line.splice(col, 1);
            } else if (row < lines.length - 1) {
              line.push(...lines.splice(row + 1, 1)[0]);
            }
            break;
          case "left":
            if (col > 0) col--;
            else if (row > 0) col = lines[--row].length;
            break;
          case "right":
            if (col < line.length) col++;
            else if (row < lines.length - 1) {
              row++;
              col = 0;
            }
            break;
          case "up":
            if (row > 0) col = Math.min(col, lines[--row].length);
            break;
          case "down":
            if (row < lines.length - 1) {
              col = Math.min(col, lines[++row].length);
            }
            break;
          case "home":
            col = 0;
            break;
          case "end":
            col = line.length;
            break;
          case "wordLeft":
            col = wordLeft(line, col);
            break;
          case "wordRight":
            col = wordRight(line, col);
            break;
          case "deleteWordLeft": {
            const to = wordLeft(line, col);
            line.splice(to, col - to);
            col = to;
            break;
          }
          case "deleteToStart":
            line.splice(0, col);
            col = 0;
            break;
          case "deleteToEnd":
            line.splice(col);
            break;
        }
        render();
      }

      // stdin closed without an explicit submit — return what we have.
      return value();
    } finally {
      restore();
    }
  });
}

const isWordChar = (char: string) => /[\p{L}\p{N}_-]/u.test(char);

function wordLeft(chars: string[], cursor: number): number {
  let i = cursor;
  while (i > 0 && !isWordChar(chars[i - 1])) i--;
  while (i > 0 && isWordChar(chars[i - 1])) i--;
  return i;
}

function wordRight(chars: string[], cursor: number): number {
  let i = cursor;
  while (i < chars.length && !isWordChar(chars[i])) i++;
  while (i < chars.length && isWordChar(chars[i])) i++;
  return i;
}
