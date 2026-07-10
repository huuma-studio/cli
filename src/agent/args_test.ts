import { assertEquals, assertThrows } from "@std/assert";
import { type AgentArgs, parseAgentArgs } from "./args.ts";

/** The parse result for an empty argv, overridden per test so each case only
 * states what its input changes. */
function parsed(overrides: Partial<AgentArgs> = {}): AgentArgs {
  return {
    tools: [],
    cliCommands: [],
    systemPrompt: undefined,
    model: undefined,
    host: undefined,
    searchEngine: undefined,
    prompt: "",
    help: false,
    ...overrides,
  };
}

Deno.test("parseAgentArgs splits --tools from the prompt", () => {
  assertEquals(
    parseAgentArgs(["--tools", "grep,read_file", "hello", "world"]),
    parsed({ tools: ["grep", "read_file"], prompt: "hello world" }),
  );
});

Deno.test("parseAgentArgs accepts --tool, --tools=, and repetition", () => {
  assertEquals(
    parseAgentArgs(["--tool", "grep", "--tools=read_file,write_file", "go"]),
    parsed({ tools: ["grep", "read_file", "write_file"], prompt: "go" }),
  );
});

Deno.test("parseAgentArgs leaves an empty prompt for the REPL", () => {
  assertEquals(
    parseAgentArgs(["--tools", "grep"]),
    parsed({ tools: ["grep"] }),
  );
});

Deno.test("parseAgentArgs treats leading non-flags as the prompt", () => {
  assertEquals(
    parseAgentArgs(["hello", "there"]),
    parsed({ prompt: "hello there" }),
  );
});

Deno.test("parseAgentArgs stops flag parsing at --", () => {
  assertEquals(
    parseAgentArgs(["--tools", "grep", "--", "--verbatim"]),
    parsed({ tools: ["grep"], prompt: "--verbatim" }),
  );
});

Deno.test("parseAgentArgs signals --help and -h", () => {
  assertEquals(parseAgentArgs(["--help"]), parsed({ help: true }));
  assertEquals(parseAgentArgs(["-h"]), parsed({ help: true }));
  // --help wins even after otherwise-valid flags.
  assertEquals(
    parseAgentArgs(["--tools", "grep", "--help"]),
    parsed({ help: true }),
  );
});

Deno.test("parseAgentArgs keeps --help in the prompt position as text", () => {
  assertEquals(
    parseAgentArgs(["explain", "--help"]),
    parsed({ prompt: "explain --help" }),
  );
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
    parsed({ systemPrompt: "Be terse.", prompt: "fix the tests" }),
  );
});

Deno.test("parseAgentArgs accepts the --system-prompt= form", () => {
  assertEquals(
    parseAgentArgs(["--system-prompt=Be terse.", "go"]),
    parsed({ systemPrompt: "Be terse.", prompt: "go" }),
  );
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
    parsed({
      tools: ["grep"],
      systemPrompt: "Be terse.",
      prompt: "fix tests",
    }),
  );
});

Deno.test("parseAgentArgs lets the last --system-prompt win", () => {
  assertEquals(
    parseAgentArgs(["--system-prompt", "A", "--system-prompt", "B", "go"]),
    parsed({ systemPrompt: "B", prompt: "go" }),
  );
});

Deno.test("parseAgentArgs threads --system-prompt through -- to the prompt", () => {
  assertEquals(
    parseAgentArgs(["--system-prompt", "Be terse.", "--", "literal --words"]),
    parsed({ systemPrompt: "Be terse.", prompt: "literal --words" }),
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
    parsed({ systemPrompt: "--tools", prompt: "grep the code" }),
  );
});

Deno.test("parseAgentArgs reads --model before the prompt", () => {
  assertEquals(
    parseAgentArgs(["--model", "anthropic/claude-haiku-4-5", "hello"]),
    parsed({
      model: { provider: "anthropic", modelId: "claude-haiku-4-5" },
      prompt: "hello",
    }),
  );
});

Deno.test("parseAgentArgs accepts the --model= form", () => {
  assertEquals(
    parseAgentArgs(["--model=ollama/llama3.2", "go"]),
    parsed({
      model: { provider: "ollama", modelId: "llama3.2" },
      prompt: "go",
    }),
  );
});

Deno.test("parseAgentArgs lowercases the provider but keeps the model id's case", () => {
  assertEquals(parseAgentArgs(["--model", "OpenAI/GPT-4o-Mini"]).model, {
    provider: "openai",
    modelId: "GPT-4o-Mini",
  });
});

Deno.test("parseAgentArgs splits --model on the first slash only", () => {
  // Ids on OpenAI-compatible routers may contain slashes themselves.
  assertEquals(
    parseAgentArgs(["--model", "openai/meta-llama/Llama-3-8b"]),
    parsed({ model: { provider: "openai", modelId: "meta-llama/Llama-3-8b" } }),
  );
});

Deno.test("parseAgentArgs lets the last --model win", () => {
  assertEquals(
    parseAgentArgs(["--model", "openai/a", "--model", "ollama/b"]).model,
    { provider: "ollama", modelId: "b" },
  );
});

Deno.test("parseAgentArgs rejects --model without a value", () => {
  assertThrows(
    () => parseAgentArgs(["--model"]),
    Error,
    "Missing value for --model",
  );
  assertThrows(
    () => parseAgentArgs(["--model", ""]),
    Error,
    "Missing value for --model",
  );
  assertThrows(
    () => parseAgentArgs(["--model="]),
    Error,
    "Missing value for --model",
  );
});

Deno.test("parseAgentArgs rejects a --model value without a provider/model split", () => {
  for (const value of ["claude-haiku-4-5", "/claude-haiku-4-5", "anthropic/"]) {
    assertThrows(
      () => parseAgentArgs(["--model", value]),
      Error,
      `Invalid --model value "${value}"`,
    );
  }
});

Deno.test("parseAgentArgs reads --cli-commands in both forms and accumulates", () => {
  assertEquals(
    parseAgentArgs(["--cli-commands", "deno, git", "--cli-commands=npm", "go"]),
    parsed({ cliCommands: ["deno", "git", "npm"], prompt: "go" }),
  );
});

Deno.test("parseAgentArgs rejects --cli-commands without a value", () => {
  assertThrows(
    () => parseAgentArgs(["--cli-commands"]),
    Error,
    "Missing value for --cli-commands",
  );
  assertThrows(
    () => parseAgentArgs(["--cli-commands", " "]),
    Error,
    "Missing value for --cli-commands",
  );
  assertThrows(
    () => parseAgentArgs(["--cli-commands="]),
    Error,
    "Missing value for --cli-commands",
  );
});

Deno.test("parseAgentArgs reads --host in both forms, last wins", () => {
  assertEquals(
    parseAgentArgs(["--host", "http://a:1234", "--host=http://b:5678"]),
    parsed({ host: "http://b:5678" }),
  );
});

Deno.test("parseAgentArgs rejects --host without a value", () => {
  assertThrows(
    () => parseAgentArgs(["--host"]),
    Error,
    "Missing value for --host",
  );
  assertThrows(
    () => parseAgentArgs(["--host="]),
    Error,
    "Missing value for --host",
  );
});

Deno.test("parseAgentArgs reads --search-engine in both forms, last wins", () => {
  assertEquals(
    parseAgentArgs(["--search-engine", "brave", "find deno"]),
    parsed({ searchEngine: "brave", prompt: "find deno" }),
  );
  assertEquals(
    parseAgentArgs(["--search-engine=brave", "--search-engine=perplexity"]),
    parsed({ searchEngine: "perplexity" }),
  );
});

Deno.test("parseAgentArgs rejects --search-engine without a value", () => {
  assertThrows(
    () => parseAgentArgs(["--search-engine"]),
    Error,
    "Missing value for --search-engine",
  );
  assertThrows(
    () => parseAgentArgs(["--search-engine="]),
    Error,
    "Missing value for --search-engine",
  );
});
