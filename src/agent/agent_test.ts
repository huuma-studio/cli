import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import type { Message } from "@huuma/ai/agent";
import agentCommand, {
  type Assistant,
  chat,
  modelText,
  ollamaApiKey,
  parseAgentArgs,
  resolveApiKey,
  resolveModel,
  resolveTools,
  respond,
  setup,
} from "./agent.ts";

/** Runs `fn` with terminal output suppressed so the REPL chrome
 * ("Thinking...", colors, error lines) stays out of the test report. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const { log, error } = console;
  const writeSync = Deno.stdout.writeSync.bind(Deno.stdout);
  console.log = () => {};
  console.error = () => {};
  Deno.stdout.writeSync = () => 0;
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
    Deno.stdout.writeSync = writeSync;
  }
}

function modelReply(text: string): Message {
  return { role: "model", contents: [{ text }], toolCalls: [] };
}

/** The prompt type `Assistant.run` accepts, derived so the fakes below track
 * @huuma/ai (which widened it beyond `string` for media input). */
type RunPrompt = Parameters<Assistant["run"]>[0];

/** Sets env vars (a `null` value clears one) for the duration of `fn`, then
 * restores the prior environment. Requires `--allow-env`. */
async function withEnv(
  vars: Record<string, string | null>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const prior = new Map(
    Object.keys(vars).map((key) => [key, Deno.env.get(key)]),
  );
  for (const [key, value] of Object.entries(vars)) {
    if (value === null) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

Deno.test("modelText returns the text of the last model message", () => {
  const messages: Message[] = [
    { role: "user", contents: "Hi" },
    { role: "model", contents: [{ text: "Hello!" }], toolCalls: [] },
    { role: "user", contents: "How are you?" },
    { role: "model", contents: [{ text: "Great." }], toolCalls: [] },
  ];
  assertEquals(modelText(messages), "Great.");
});

Deno.test("modelText skips trailing non-model messages", () => {
  const messages: Message[] = [
    { role: "model", contents: [{ text: "Done." }], toolCalls: [] },
    {
      role: "tool",
      contents: [{
        toolResult: { id: "1", name: "cli", result: { output: "ok" } },
      }],
    },
  ];
  assertEquals(modelText(messages), "Done.");
});

Deno.test("modelText joins multiple text contents and ignores tool calls", () => {
  const toolCall = { toolCall: { id: "1", name: "cli", props: {} } };
  const messages: Message[] = [
    {
      role: "model",
      contents: [{ text: "First." }, toolCall, { text: "Second." }],
      toolCalls: [toolCall.toolCall],
    },
  ];
  assertEquals(modelText(messages), "First.\nSecond.");
});

Deno.test("modelText falls back when no model text exists", () => {
  assertEquals(modelText([]), "(no response)");
  assertEquals(
    modelText([{ role: "user", contents: "Hi" }]),
    "(no response)",
  );
});

Deno.test("respond returns the conversation from a successful run", async () => {
  const conversation: Message[] = [
    { role: "user", contents: "Hi" },
    modelReply("Hello!"),
  ];
  const assistant: Assistant = { run: () => Promise.resolve(conversation) };

  const result = await quiet(() => respond(assistant, "Hi", []));

  assertEquals(result, { messages: conversation, ok: true });
});

Deno.test("respond threads the prompt and prior history into run", async () => {
  const history: Message[] = [
    { role: "user", contents: "Hi" },
    modelReply("Hello!"),
  ];
  let seen: { prompt: RunPrompt; history?: Message[] } | undefined;
  const assistant: Assistant = {
    run: (prompt, history) => {
      seen = { prompt, history };
      return Promise.resolve([...(history ?? []), modelReply("Sure.")]);
    },
  };

  await quiet(() => respond(assistant, "Tell me more", history));

  assertEquals(seen, { prompt: "Tell me more", history });
});

Deno.test("respond keeps the prior history when run fails", async () => {
  const history: Message[] = [
    { role: "user", contents: "Hi" },
    modelReply("Hello!"),
  ];
  const assistant: Assistant = {
    run: () => Promise.reject(new Error("rate limited")),
  };

  const result = await quiet(() => respond(assistant, "next", history));

  assertEquals(result, { messages: history, ok: false });
});

Deno.test("chat answers a one-shot prompt, runs once, and returns ''", async () => {
  const calls: { prompt: RunPrompt; history?: Message[] }[] = [];
  const assistant: Assistant = {
    run: (prompt, history) => {
      calls.push({ prompt, history });
      return Promise.resolve([
        { role: "user", contents: prompt },
        modelReply("hi"),
      ]);
    },
  };

  const result = await quiet(() => chat(assistant, "hello there"));

  // one-shot returns "" (not the REPL's "Bye!") and never enters the loop
  assertEquals(result, "");
  assertEquals(calls, [{ prompt: "hello there", history: [] }]);
});

Deno.test("chat flags a failed one-shot with a non-zero exit code", async () => {
  const priorExitCode = Deno.exitCode;
  try {
    const assistant: Assistant = {
      run: () => Promise.reject(new Error("boom")),
    };

    const result = await quiet(() => chat(assistant, "hi"));

    assertEquals(result, ""); // still returns the one-shot sentinel
    assertEquals(Deno.exitCode, 1); // failure surfaces via the exit code
  } finally {
    Deno.exitCode = priorExitCode;
  }
});

Deno.test("resolveModel returns HUUMA_AGENT_MODEL without prompting", async () => {
  await withEnv({ HUUMA_AGENT_MODEL: "claude-opus-4-8" }, async () => {
    assertEquals(await resolveModel("fallback-model"), "claude-opus-4-8");
  });
});

Deno.test("resolveApiKey uses HUUMA_AGENT_API_KEY even when provider keys are set", async () => {
  await withEnv(
    {
      HUUMA_AGENT_API_KEY: "the-key",
      OPENAI_API_KEY: "ambient",
      ANTHROPIC_API_KEY: "ambient",
    },
    async () => {
      // Ambient provider keys must not override the explicit HUUMA_AGENT_API_KEY.
      assertEquals(await resolveApiKey("OpenAI"), "the-key");
      assertEquals(await resolveApiKey("Anthropic"), "the-key");
    },
  );
});

Deno.test("setup rejects an unknown HUUMA_AGENT_PROVIDER", async () => {
  await withEnv({ HUUMA_AGENT_PROVIDER: "gemini" }, async () => {
    await assertRejects(() => setup(), Error, 'Unknown provider "gemini"');
  });
});

Deno.test("the agent command renders a setup failure instead of crashing", async () => {
  const priorExitCode = Deno.exitCode;
  try {
    await withEnv({ HUUMA_AGENT_PROVIDER: "gemini" }, async () => {
      const result = await quiet(() => agentCommand(["hi"]));
      assertEquals(result, ""); // handled cleanly, not thrown
      assertEquals(Deno.exitCode, 1);
    });
  } finally {
    Deno.exitCode = priorExitCode;
  }
});

Deno.test("ollamaApiKey returns HUUMA_AGENT_API_KEY, else undefined", async () => {
  await withEnv(
    { HUUMA_AGENT_API_KEY: "key", OLLAMA_API_KEY: "ambient" },
    () => assertEquals(ollamaApiKey(), "key"),
  );
  await withEnv(
    { HUUMA_AGENT_API_KEY: null },
    () => assertEquals(ollamaApiKey(), undefined),
  );
});

/** The names of the tools {@link resolveTools} builds for `names`, in order. */
function toolNames(names: string[]): string[] {
  return resolveTools(names).tools.map((tool) => tool.name);
}

Deno.test("resolveTools returns no tools for an empty selection", () => {
  assertEquals(resolveTools([]), { tools: [], subagentNames: [] });
});

Deno.test("resolveTools builds the named tools, case-insensitively", () => {
  assertEquals(toolNames(["GREP", "fetch_website"]), ["grep", "fetch_website"]);
});

Deno.test("resolveTools expands the files group", () => {
  assertEquals(toolNames(["files"]), [
    "read_file",
    "write_file",
    "create_directory",
    "delete_file",
    "edit_file",
  ]);
});

Deno.test("resolveTools rejects an unknown tool", () => {
  assertThrows(
    () => resolveTools(["browser"]),
    Error,
    'Unknown tool "browser"',
  );
});

Deno.test("resolveTools lists preset sub-agents among the valid names", () => {
  const error = assertThrows(() => resolveTools(["browser"]), Error);
  assertStringIncludes(error.message, "explorer");
});

Deno.test("resolveTools defers preset sub-agents without needing a model", () => {
  assertEquals(resolveTools(["Explorer"]), {
    tools: [],
    subagentNames: ["explorer"],
  });
});

Deno.test("resolveTools dedupes a repeated preset", () => {
  assertEquals(resolveTools(["explorer", "Explorer"]).subagentNames, [
    "explorer",
  ]);
});

Deno.test("resolveTools mixes eager tools with deferred presets", () => {
  const { tools, subagentNames } = resolveTools(["grep", "explorer"]);
  assertEquals(tools.map((tool) => tool.name), ["grep"]);
  assertEquals(subagentNames, ["explorer"]);
});

Deno.test("resolveTools wires the cli allow-list from the environment", async () => {
  await withEnv({ HUUMA_AGENT_CLI_COMMANDS: "deno, git" }, () => {
    const [tool, ...rest] = resolveTools(["cli"]).tools;
    assertEquals(rest, []);
    assertEquals(tool.name, "cli");
    // The allow-list surfaces in the description the model sees.
    assertEquals(tool.description.includes("deno, git"), true);
  });
});

Deno.test("resolveTools requires an allow-list for the cli tool", async () => {
  await withEnv({ HUUMA_AGENT_CLI_COMMANDS: null }, () => {
    assertThrows(
      () => resolveTools(["cli"]),
      Error,
      "HUUMA_AGENT_CLI_COMMANDS",
    );
  });
});

Deno.test("resolveTools builds search once an engine is set", async () => {
  await withEnv(
    { HUUMA_AGENT_SEARCH_ENGINE: "brave" },
    () => assertEquals(toolNames(["search"]), ["search"]),
  );
});

Deno.test("resolveTools requires an engine for the search tool", async () => {
  await withEnv({ HUUMA_AGENT_SEARCH_ENGINE: null }, () => {
    assertThrows(
      () => resolveTools(["search"]),
      Error,
      "HUUMA_AGENT_SEARCH_ENGINE",
    );
  });
});

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

Deno.test("the agent command renders an unknown --tools value as an error", async () => {
  const priorExitCode = Deno.exitCode;
  try {
    const result = await quiet(() =>
      agentCommand(["--tools", "browser", "hi"])
    );
    assertEquals(result, ""); // handled cleanly, not thrown
    assertEquals(Deno.exitCode, 1);
  } finally {
    Deno.exitCode = priorExitCode;
  }
});

Deno.test("the agent command returns help for --help without starting a chat", async () => {
  // No HUUMA_AGENT_PROVIDER set: reaching setup() would block on the provider
  // prompt, so returning the usage text proves --help short-circuits first.
  const result = await quiet(() => agentCommand(["--help"]));
  assertStringIncludes(result, "huuma agent [OPTIONS] [PROMPT]");
  assertStringIncludes(result, "--tools");
  assertStringIncludes(result, "--system-prompt");
});

Deno.test("the agent help lists the explorer preset", async () => {
  const result = await quiet(() => agentCommand(["--help"]));
  assertStringIncludes(result, "SUBAGENTS");
  assertStringIncludes(result, "explorer");
});
