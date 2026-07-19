import { assertEquals, assertThrows } from "@std/assert";
import {
  type LocalAgentArgs,
  type ManagedAgentArgs,
  parseAgentArgs,
  type ParsedAgentArgs,
} from "./args.ts";

/** The parse result for an empty argv in local chat mode, overridden per test
 * so each case only states what its input changes. `--help` short-circuits to
 * `{ help: true }` (see HelpAgentArgs) and is asserted directly — it does not
 * flow through this helper. */
function parsed(overrides: Partial<LocalAgentArgs> = {}): LocalAgentArgs {
  return {
    mode: "local",
    tools: [],
    cliCommands: [],
    systemPrompt: undefined,
    model: undefined,
    host: undefined,
    searchEngine: undefined,
    skillsPath: undefined,
    prompt: "",
    help: false,
    ...overrides,
  };
}

/** A minimal managed-flags bundle sufficient to satisfy the parser (mode
 * selection only — value validation lives in resolveManagedConfig, tested in
 * `managed/config_test.ts`). Override per test to drop or mutate one field. */
function managed(
  overrides: Partial<ManagedAgentArgs> = {},
): ManagedAgentArgs {
  return {
    mode: "managed",
    tools: [],
    cliCommands: [],
    systemPrompt: undefined,
    model: { provider: "anthropic", modelId: "claude-haiku-4-5" },
    host: undefined,
    searchEngine: undefined,
    skillsPath: undefined,
    prompt: "",
    help: false,
    history: "/workspace/history.json",
    cwd: "/workspace",
    callbackUrl: "https://api.huuma.studio/runs/1/callback",
    runId: "11111111-1111-1111-1111-111111111111",
    turnId: "22222222-2222-2222-2222-222222222222",
    turnDeadline: "2099-01-01T00:00:00Z",
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
  // --help short-circuits to HelpAgentArgs before mode selection, so it does
  // not flow through the local-mode `parsed()` helper.
  assertEquals(parseAgentArgs(["--help"]), { help: true } as ParsedAgentArgs);
  assertEquals(parseAgentArgs(["-h"]), { help: true } as ParsedAgentArgs);
  // --help wins even after otherwise-valid flags.
  assertEquals(
    parseAgentArgs(["--tools", "grep", "--help"]),
    { help: true } as ParsedAgentArgs,
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
  assertEquals(
    parseAgentArgs(["--model", "OpenAI/GPT-4o-Mini"]),
    parsed({ model: { provider: "openai", modelId: "GPT-4o-Mini" } }),
  );
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
    parseAgentArgs(["--model", "openai/a", "--model", "ollama/b"]),
    parsed({ model: { provider: "ollama", modelId: "b" } }),
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

Deno.test("parseAgentArgs reads --skills-path in both forms, last wins", () => {
  assertEquals(
    parseAgentArgs(["--skills-path", "./skills-a", "list them"]),
    parsed({ skillsPath: "./skills-a", prompt: "list them" }),
  );
  assertEquals(
    parseAgentArgs(["--skills-path=./a", "--skills-path=./b"]),
    parsed({ skillsPath: "./b" }),
  );
});

Deno.test("parseAgentArgs rejects --skills-path without a value", () => {
  assertThrows(
    () => parseAgentArgs(["--skills-path"]),
    Error,
    "Missing value for --skills-path",
  );
  assertThrows(
    () => parseAgentArgs(["--skills-path="]),
    Error,
    "Missing value for --skills-path",
  );
  assertThrows(
    () => parseAgentArgs(["--skills-path", "  "]),
    Error,
    "Missing value for --skills-path",
  );
});

Deno.test("parseAgentArgs mentions --skills-path in the unknown-flag error", () => {
  assertThrows(
    () => parseAgentArgs(["--bogus"]),
    Error,
    "--skills-path",
  );
});

// ---------------------------------------------------------------------------
// Managed turn mode (T2): mode selection and parser-level shape enforcement.
// Value validation (required-together, UUID, URL, RFC3339, secret, provider
// credential/host) is exercised in `managed/config_test.ts`.
// ---------------------------------------------------------------------------

Deno.test("parseAgentArgs selects local mode when --callback-url is absent", () => {
  // The default — no managed-turn flags — is local chat. Existing flags still
  // parse exactly as before; the only addition is the `mode: "local"` field.
  assertEquals(parseAgentArgs([]), parsed());
  assertEquals(
    parseAgentArgs(["--model", "anthropic/x", "hi"]),
    parsed({ model: { provider: "anthropic", modelId: "x" }, prompt: "hi" }),
  );
});

Deno.test("parseAgentArgs selects managed mode when --callback-url is present", () => {
  const result = parseAgentArgs([
    "--callback-url",
    "https://api.huuma.studio/runs/1/callback",
    "--history",
    "/workspace/history.json",
    "--cwd",
    "/workspace",
    "--run-id",
    "11111111-1111-1111-1111-111111111111",
    "--turn-id",
    "22222222-2222-2222-2222-222222222222",
    "--turn-deadline",
    "2099-01-01T00:00:00Z",
    "--model",
    "anthropic/claude-haiku-4-5",
  ]);
  assertEquals(result, managed());
  // The parser only selects mode; it does not validate flag values. Missing
  // required flags remain `undefined` and surface in resolveManagedConfig.
  assertEquals(
    parseAgentArgs(["--callback-url", "https://x.invalid/cb"]),
    managed({
      history: undefined,
      cwd: undefined,
      runId: undefined,
      turnId: undefined,
      turnDeadline: undefined,
      model: undefined,
      callbackUrl: "https://x.invalid/cb",
    }),
  );
});

Deno.test("parseAgentArgs accepts the managed flags in --flag=value form", () => {
  assertEquals(
    parseAgentArgs([
      "--callback-url=https://x.invalid/cb",
      "--history=/h.json",
      "--cwd=/workspace",
      "--run-id=11111111-1111-1111-1111-111111111111",
      "--turn-id=22222222-2222-2222-2222-222222222222",
      "--turn-deadline=2099-01-01T00:00:00Z",
      "--model=ollama/llama3.2",
      "--host=http://localhost:11434",
    ]),
    managed({
      model: { provider: "ollama", modelId: "llama3.2" },
      host: "http://localhost:11434",
      history: "/h.json",
      callbackUrl: "https://x.invalid/cb",
    }),
  );
});

Deno.test("parseAgentArgs threads shared flags into managed mode", () => {
  // --tools / --system-prompt / --search-engine / --skills-path / --cli-commands
  // are valid in both modes; the parser keeps them on the managed result.
  assertEquals(
    parseAgentArgs([
      "--callback-url",
      "https://x.invalid/cb",
      "--history",
      "/h.json",
      "--cwd",
      "/workspace",
      "--run-id",
      "11111111-1111-1111-1111-111111111111",
      "--turn-id",
      "22222222-2222-2222-2222-222222222222",
      "--turn-deadline",
      "2099-01-01T00:00:00Z",
      "--model",
      "anthropic/x",
      "--tools",
      "grep,read_file",
      "--cli-commands",
      "deno",
      "--search-engine",
      "brave",
      "--skills-path",
      "./skills",
      "--system-prompt",
      "Be terse.",
    ]),
    managed({
      tools: ["grep", "read_file"],
      cliCommands: ["deno"],
      searchEngine: "brave",
      skillsPath: "./skills",
      systemPrompt: "Be terse.",
      model: { provider: "anthropic", modelId: "x" },
      history: "/h.json",
      callbackUrl: "https://x.invalid/cb",
    }),
  );
});

Deno.test("parseAgentArgs rejects each managed-only flag without --callback-url", () => {
  // Passing a managed-turn-only flag without --callback-url is a configuration
  // error, not a local chat that ignores it. The first such flag (in canonical
  // order: history, cwd, run-id, turn-id, turn-deadline) is reported.
  for (
    const [flag, value] of [
      ["--history", "/h.json"],
      ["--cwd", "/workspace"],
      ["--run-id", "11111111-1111-1111-1111-111111111111"],
      ["--turn-id", "22222222-2222-2222-2222-222222222222"],
      ["--turn-deadline", "2099-01-01T00:00:00Z"],
    ] as const
  ) {
    assertThrows(
      () => parseAgentArgs([flag, value]),
      Error,
      `${flag} is a managed-turn flag and requires --callback-url`,
    );
  }
});

Deno.test("parseAgentArgs reports the first canonical managed-only orphan", () => {
  // --run-id alone reports --run-id. Both --history and --cwd present reports
  // --history first (canonical order: history, cwd, run-id, turn-id, deadline).
  assertThrows(
    () => parseAgentArgs(["--run-id", "11111111-1111-1111-1111-111111111111"]),
    Error,
    "--run-id is a managed-turn flag and requires --callback-url",
  );
  assertThrows(
    () =>
      parseAgentArgs([
        "--cwd",
        "/workspace",
        "--history",
        "/h.json",
      ]),
    Error,
    "--history is a managed-turn flag and requires --callback-url",
  );
});

Deno.test("parseAgentArgs rejects a positional prompt in managed mode", () => {
  // The triggering user message already exists at the end of --history, so a
  // prompt on the command line is a misuse — even with the full flag group.
  assertThrows(
    () =>
      parseAgentArgs([
        "--callback-url",
        "https://x.invalid/cb",
        "--history",
        "/h.json",
        "--cwd",
        "/workspace",
        "--run-id",
        "11111111-1111-1111-1111-111111111111",
        "--turn-id",
        "22222222-2222-2222-2222-222222222222",
        "--turn-deadline",
        "2099-01-01T00:00:00Z",
        "--model",
        "anthropic/x",
        "do the thing",
      ]),
    Error,
    "A positional prompt is not allowed in managed turn mode",
  );
});

Deno.test("parseAgentArgs allows --tools/-- with -- in managed mode (no prompt)", () => {
  // -- ends flag parsing; the remaining tokens would be the prompt. In
  // managed mode a non-empty prompt is rejected, but `--` followed by nothing
  // is fine (empty prompt).
  assertEquals(
    parseAgentArgs(["--callback-url", "https://x.invalid/cb", "--"]),
    managed({
      history: undefined,
      cwd: undefined,
      runId: undefined,
      turnId: undefined,
      turnDeadline: undefined,
      model: undefined,
      callbackUrl: "https://x.invalid/cb",
    }),
  );
});

Deno.test("parseAgentArgs rejects each managed flag without a value", () => {
  // The new value flags follow the same "Missing value for --flag" pattern as
  // the existing ones (both the space and `=` forms).
  for (
    const flag of [
      "--history",
      "--cwd",
      "--callback-url",
      "--run-id",
      "--turn-id",
      "--turn-deadline",
    ]
  ) {
    assertThrows(
      () => parseAgentArgs([flag]),
      Error,
      `Missing value for ${flag}`,
    );
    assertThrows(
      () => parseAgentArgs([`${flag}=`]),
      Error,
      `Missing value for ${flag}`,
    );
    assertThrows(
      () => parseAgentArgs([flag, "   "]),
      Error,
      `Missing value for ${flag}`,
    );
  }
});

Deno.test("parseAgentArgs mentions the managed flags in the unknown-flag error", () => {
  // The unknown-flag hint lists the new managed-turn flags so a typo is
  // discoverable. Each new flag name appears in the error.
  for (
    const flag of [
      "--history",
      "--cwd",
      "--callback-url",
      "--run-id",
      "--turn-id",
      "--turn-deadline",
    ]
  ) {
    assertThrows(
      () => parseAgentArgs(["--bogus"]),
      Error,
      flag,
    );
  }
});
