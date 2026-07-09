import { assertEquals, assertThrows } from "@std/assert";
import { parseAgentArgs } from "./args.ts";

Deno.test("parseAgentArgs splits --tools from the prompt", () => {
  assertEquals(
    parseAgentArgs(["--tools", "grep,read_file", "hello", "world"]),
    {
      tools: ["grep", "read_file"],
      systemPrompt: undefined,
      prompt: "hello world",
      help: false,
    },
  );
});

Deno.test("parseAgentArgs accepts --tool, --tools=, and repetition", () => {
  assertEquals(
    parseAgentArgs(["--tool", "grep", "--tools=read_file,write_file", "go"]),
    {
      tools: ["grep", "read_file", "write_file"],
      systemPrompt: undefined,
      prompt: "go",
      help: false,
    },
  );
});

Deno.test("parseAgentArgs leaves an empty prompt for the REPL", () => {
  assertEquals(parseAgentArgs(["--tools", "grep"]), {
    tools: ["grep"],
    systemPrompt: undefined,
    prompt: "",
    help: false,
  });
});

Deno.test("parseAgentArgs treats leading non-flags as the prompt", () => {
  assertEquals(parseAgentArgs(["hello", "there"]), {
    tools: [],
    systemPrompt: undefined,
    prompt: "hello there",
    help: false,
  });
});

Deno.test("parseAgentArgs stops flag parsing at --", () => {
  assertEquals(parseAgentArgs(["--tools", "grep", "--", "--verbatim"]), {
    tools: ["grep"],
    systemPrompt: undefined,
    prompt: "--verbatim",
    help: false,
  });
});

Deno.test("parseAgentArgs signals --help and -h", () => {
  const help = { tools: [], systemPrompt: undefined, prompt: "", help: true };
  assertEquals(parseAgentArgs(["--help"]), help);
  assertEquals(parseAgentArgs(["-h"]), help);
  // --help wins even after otherwise-valid flags.
  assertEquals(parseAgentArgs(["--tools", "grep", "--help"]), help);
});

Deno.test("parseAgentArgs keeps --help in the prompt position as text", () => {
  assertEquals(parseAgentArgs(["explain", "--help"]), {
    tools: [],
    systemPrompt: undefined,
    prompt: "explain --help",
    help: false,
  });
});

Deno.test("parseAgentArgs rejects an unknown flag", () => {
  assertThrows(
    () => parseAgentArgs(["--toolz", "grep"]),
    Error,
    'Unknown flag "--toolz"',
  );
});

Deno.test("parseAgentArgs rejects --tools without a value", () => {
  assertThrows(
    () => parseAgentArgs(["--tools"]),
    Error,
    "Missing value for --tools",
  );
});

Deno.test("parseAgentArgs reads --system-prompt before the prompt", () => {
  assertEquals(
    parseAgentArgs(["--system-prompt", "Be terse.", "fix", "the", "tests"]),
    {
      tools: [],
      systemPrompt: "Be terse.",
      prompt: "fix the tests",
      help: false,
    },
  );
});

Deno.test("parseAgentArgs accepts the --system-prompt= form", () => {
  assertEquals(parseAgentArgs(["--system-prompt=Be terse.", "go"]), {
    tools: [],
    systemPrompt: "Be terse.",
    prompt: "go",
    help: false,
  });
});

Deno.test("parseAgentArgs combines --tools and --system-prompt", () => {
  assertEquals(
    parseAgentArgs([
      "--tools",
      "grep",
      "--system-prompt",
      "Be terse.",
      "fix tests",
    ]),
    {
      tools: ["grep"],
      systemPrompt: "Be terse.",
      prompt: "fix tests",
      help: false,
    },
  );
});

Deno.test("parseAgentArgs lets the last --system-prompt win", () => {
  assertEquals(
    parseAgentArgs(["--system-prompt", "A", "--system-prompt", "B", "go"]),
    { tools: [], systemPrompt: "B", prompt: "go", help: false },
  );
});

Deno.test("parseAgentArgs threads --system-prompt through -- to the prompt", () => {
  assertEquals(
    parseAgentArgs(["--system-prompt", "Be terse.", "--", "literal --words"]),
    {
      tools: [],
      systemPrompt: "Be terse.",
      prompt: "literal --words",
      help: false,
    },
  );
});

Deno.test("parseAgentArgs rejects --system-prompt without a value", () => {
  assertThrows(
    () => parseAgentArgs(["--system-prompt"]),
    Error,
    "Missing value for --system-prompt",
  );
});

Deno.test("parseAgentArgs rejects an empty --system-prompt value", () => {
  assertThrows(
    () => parseAgentArgs(["--system-prompt", ""]),
    Error,
    "Missing value for --system-prompt",
  );
  assertThrows(
    () => parseAgentArgs(["--system-prompt="]),
    Error,
    "Missing value for --system-prompt",
  );
});

Deno.test("parseAgentArgs rejects a whitespace-only --system-prompt value", () => {
  assertThrows(
    () => parseAgentArgs(["--system-prompt", "   "]),
    Error,
    "Missing value for --system-prompt",
  );
});

// Pins the footgun documented in ADR 0006: the token after --system-prompt is
// always taken as its value, even when it looks like another flag. This
// mirrors how --tools consumes its value and must not change silently.
Deno.test("parseAgentArgs consumes a flag-like next token as the --system-prompt value", () => {
  assertEquals(
    parseAgentArgs(["--system-prompt", "--tools", "grep", "the code"]),
    {
      tools: [],
      systemPrompt: "--tools",
      prompt: "grep the code",
      help: false,
    },
  );
});
