import {
  abortExit,
  bold,
  CLEAR_DOWN,
  CLEAR_LINE,
  columns,
  cursorTo,
  cursorUp,
  cyan,
  dim,
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

const lineDecoder = new TextDecoder();
let lineBuffer = "";
let stdinClosed = false;

/**
 * Reads the next line from stdin. Input after the newline is kept for
 * subsequent calls. Returns `null` once stdin is closed and drained.
 */
export async function readLine(): Promise<string | null> {
  const buf = new Uint8Array(1024);

  while (true) {
    const newline = lineBuffer.indexOf("\n");
    if (newline !== -1) {
      const line = lineBuffer.slice(0, newline);
      lineBuffer = lineBuffer.slice(newline + 1);
      return line.trim();
    }

    if (stdinClosed) {
      if (lineBuffer === "") return null;
      const line = lineBuffer;
      lineBuffer = "";
      return line.trim();
    }

    const byteCount = await Deno.stdin.read(buf);
    if (byteCount === null) {
      stdinClosed = true;
      continue;
    }
    lineBuffer += lineDecoder.decode(buf.subarray(0, byteCount), {
      stream: true,
    });
  }
}

export interface QuestionOptions {
  default?: string;
  validate?: (value: string) => string | undefined;
}

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
