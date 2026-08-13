import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  closeMcpConnections,
  type McpServerConfig,
  mergeMcpServers,
  parseInlineMcpServer,
  parseMcpConfig,
  resolveMcpConfig,
  resolveMcpServers,
  tokenizeStdioCommand,
} from "./mcp.ts";

// ---------------------------------------------------------------------------
// tokenizeStdioCommand
// ---------------------------------------------------------------------------

Deno.test("tokenizeStdioCommand splits on whitespace", () => {
  assertEquals(tokenizeStdioCommand("npx -y @some/server"), [
    "npx",
    "-y",
    "@some/server",
  ]);
});

Deno.test("tokenizeStdioCommand handles multiple spaces between tokens", () => {
  assertEquals(tokenizeStdioCommand("npx   -y    @some/server"), [
    "npx",
    "-y",
    "@some/server",
  ]);
});

Deno.test("tokenizeStdioCommand handles single-quoted segments", () => {
  assertEquals(tokenizeStdioCommand("echo 'hello world' end"), [
    "echo",
    "hello world",
    "end",
  ]);
});

Deno.test("tokenizeStdioCommand handles double-quoted segments", () => {
  assertEquals(tokenizeStdioCommand('echo "hello world" end'), [
    "echo",
    "hello world",
    "end",
  ]);
});

Deno.test("tokenizeStdioCommand handles backslash-escaped spaces in double quotes", () => {
  assertEquals(tokenizeStdioCommand('echo "hello\\ world" end'), [
    "echo",
    "hello world",
    "end",
  ]);
});

Deno.test("tokenizeStdioCommand handles backslash-escaped spaces outside quotes", () => {
  assertEquals(tokenizeStdioCommand("echo hello\\ world end"), [
    "echo",
    "hello world",
    "end",
  ]);
});

Deno.test("tokenizeStdioCommand handles backslash-escaped double quote inside double quotes", () => {
  assertEquals(tokenizeStdioCommand('echo "say \\"hi\\""'), [
    "echo",
    'say "hi"',
  ]);
});

Deno.test("tokenizeStdioCommand handles empty single quotes", () => {
  assertEquals(tokenizeStdioCommand("echo '' end"), [
    "echo",
    "",
    "end",
  ]);
});

Deno.test("tokenizeStdioCommand handles empty double quotes", () => {
  assertEquals(tokenizeStdioCommand('echo "" end'), [
    "echo",
    "",
    "end",
  ]);
});

Deno.test("tokenizeStdioCommand returns empty array for empty input", () => {
  assertEquals(tokenizeStdioCommand(""), []);
  assertEquals(tokenizeStdioCommand("   "), []);
});

Deno.test("tokenizeStdioCommand throws on unterminated single quote", () => {
  assertThrows(
    () => tokenizeStdioCommand("echo 'unterminated"),
    Error,
    "Unterminated single quote",
  );
});

Deno.test("tokenizeStdioCommand throws on unterminated double quote", () => {
  assertThrows(
    () => tokenizeStdioCommand('echo "unterminated'),
    Error,
    "Unterminated double quote",
  );
});

Deno.test("tokenizeStdioCommand handles a single token", () => {
  assertEquals(tokenizeStdioCommand("npx"), ["npx"]);
});

// ---------------------------------------------------------------------------
// parseInlineMcpServer
// ---------------------------------------------------------------------------

Deno.test("parseInlineMcpServer parses a stdio spec", () => {
  assertEquals(
    parseInlineMcpServer("myserver=command:npx -y @some/mcp-server"),
    {
      name: "myserver",
      transport: { type: "stdio", command: "npx", args: ["-y", "@some/mcp-server"] },
    },
  );
});

Deno.test("parseInlineMcpServer parses an http spec", () => {
  assertEquals(
    parseInlineMcpServer("remote=url:https://mcp.example.com/sse"),
    {
      name: "remote",
      transport: { type: "http", url: "https://mcp.example.com/sse" },
    },
  );
});

Deno.test("parseInlineMcpServer parses a stdio spec with quoted args", () => {
  assertEquals(
    parseInlineMcpServer("fs=command:npx -y '@modelcontextprotocol/server-filesystem' /tmp"),
    {
      name: "fs",
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      },
    },
  );
});

Deno.test("parseInlineMcpServer parses a stdio spec with no args", () => {
  assertEquals(
    parseInlineMcpServer("simple=command:my-server"),
    {
      name: "simple",
      transport: { type: "stdio", command: "my-server", args: [] },
    },
  );
});

Deno.test("parseInlineMcpServer rejects a spec without '='", () => {
  assertThrows(
    () => parseInlineMcpServer("no-equals-here"),
    Error,
    "Expected name=spec",
  );
});

Deno.test("parseInlineMcpServer rejects an empty server name", () => {
  assertThrows(
    () => parseInlineMcpServer("=command:npx"),
    Error,
    "server name before",
  );
});

Deno.test("parseInlineMcpServer rejects an invalid server name", () => {
  assertThrows(
    () => parseInlineMcpServer("123bad=command:npx"),
    Error,
    'Invalid MCP server name "123bad"',
  );
});

Deno.test("parseInlineMcpServer rejects an unknown spec prefix", () => {
  assertThrows(
    () => parseInlineMcpServer("myserver=foo:npx"),
    Error,
    '"command:" (stdio) or "url:" (http)',
  );
});

Deno.test("parseInlineMcpServer rejects an empty command after command:", () => {
  assertThrows(
    () => parseInlineMcpServer("myserver=command:"),
    Error,
    "command after",
  );
});

Deno.test("parseInlineMcpServer rejects an empty url after url:", () => {
  assertThrows(
    () => parseInlineMcpServer("myserver=url:"),
    Error,
    "URL after",
  );
});

// ---------------------------------------------------------------------------
// parseMcpConfig
// ---------------------------------------------------------------------------

/** Writes `content` to a temp file and returns the path + cleanup. */
async function writeConfig(
  content: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "mcp.json");
  await Deno.writeTextFile(path, content);
  return { path, cleanup: async () => await Deno.remove(dir, { recursive: true }) };
}

Deno.test("parseMcpConfig parses a valid config file with stdio and http servers", async () => {
  const { path, cleanup } = await writeConfig(JSON.stringify({
    "my-server": {
      type: "stdio",
      command: "npx",
      args: ["-y", "@some/mcp-server"],
    },
    "remote-server": {
      type: "http",
      url: "https://mcp.example.com/sse",
    },
  }));
  try {
    const servers = await parseMcpConfig(path);
    assertEquals(servers.length, 2);
    assertEquals(servers[0], {
      name: "my-server",
      transport: { type: "stdio", command: "npx", args: ["-y", "@some/mcp-server"] },
      optional: false,
    });
    assertEquals(servers[1], {
      name: "remote-server",
      transport: { type: "http", url: "https://mcp.example.com/sse" },
      optional: false,
    });
  } finally {
    await cleanup();
  }
});

Deno.test("parseMcpConfig parses the optional field", async () => {
  const { path, cleanup } = await writeConfig(JSON.stringify({
    "flaky": {
      type: "http",
      url: "https://mcp.example.com/flaky",
      optional: true,
    },
  }));
  try {
    const servers = await parseMcpConfig(path);
    assertEquals(servers[0]!.optional, true);
  } finally {
    await cleanup();
  }
});

Deno.test("parseMcpConfig defaults optional to false when absent", async () => {
  const { path, cleanup } = await writeConfig(JSON.stringify({
    "srv": { type: "http", url: "https://mcp.example.com" },
  }));
  try {
    const servers = await parseMcpConfig(path);
    assertEquals(servers[0]!.optional, false);
  } finally {
    await cleanup();
  }
});

Deno.test("parseMcpConfig infers stdio transport from command field", async () => {
  const { path, cleanup } = await writeConfig(JSON.stringify({
    "srv": { command: "npx", args: ["-y", "foo"] },
  }));
  try {
    const servers = await parseMcpConfig(path);
    assertEquals(servers[0]!.transport.type, "stdio");
  } finally {
    await cleanup();
  }
});

Deno.test("parseMcpConfig infers http transport from url field", async () => {
  const { path, cleanup } = await writeConfig(JSON.stringify({
    "srv": { url: "https://mcp.example.com" },
  }));
  try {
    const servers = await parseMcpConfig(path);
    assertEquals(servers[0]!.transport.type, "http");
  } finally {
    await cleanup();
  }
});

Deno.test("parseMcpConfig rejects a missing file", async () => {
  await assertRejects(
    () => parseMcpConfig("/nonexistent/path/mcp.json"),
    Error,
    "Cannot read MCP config file",
  );
});

Deno.test("parseMcpConfig rejects invalid JSON", async () => {
  const { path, cleanup } = await writeConfig("{not valid json");
  try {
    await assertRejects(
      () => parseMcpConfig(path),
      Error,
      "not valid JSON",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("parseMcpConfig rejects a non-object root", async () => {
  const { path, cleanup } = await writeConfig("[]");
  try {
    await assertRejects(
      () => parseMcpConfig(path),
      Error,
      "must be a JSON object",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("parseMcpConfig rejects an invalid server name", async () => {
  const { path, cleanup } = await writeConfig(JSON.stringify({
    "123bad": { type: "http", url: "https://x" },
  }));
  try {
    await assertRejects(
      () => parseMcpConfig(path),
      Error,
      'Invalid MCP server name "123bad"',
    );
  } finally {
    await cleanup();
  }
});

Deno.test("parseMcpConfig rejects a server entry missing a transport", async () => {
  const { path, cleanup } = await writeConfig(JSON.stringify({
    "srv": { optional: true },
  }));
  try {
    await assertRejects(
      () => parseMcpConfig(path),
      Error,
      "missing a transport",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("parseMcpConfig rejects a stdio server with a missing command", async () => {
  const { path, cleanup } = await writeConfig(JSON.stringify({
    "srv": { type: "stdio", args: ["foo"] },
  }));
  try {
    await assertRejects(
      () => parseMcpConfig(path),
      Error,
      '"command" is missing',
    );
  } finally {
    await cleanup();
  }
});

Deno.test("parseMcpConfig rejects non-string args", async () => {
  const { path, cleanup } = await writeConfig(JSON.stringify({
    "srv": { command: "npx", args: ["ok", 123] },
  }));
  try {
    await assertRejects(
      () => parseMcpConfig(path),
      Error,
      "non-string elements",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("parseMcpConfig rejects an http server with a missing url", async () => {
  const { path, cleanup } = await writeConfig(JSON.stringify({
    "srv": { type: "http" },
  }));
  try {
    await assertRejects(
      () => parseMcpConfig(path),
      Error,
      '"url" is missing',
    );
  } finally {
    await cleanup();
  }
});

Deno.test("parseMcpConfig returns empty array for an empty object", async () => {
  const { path, cleanup } = await writeConfig("{}");
  try {
    const servers = await parseMcpConfig(path);
    assertEquals(servers, []);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// mergeMcpServers
// ---------------------------------------------------------------------------

Deno.test("mergeMcpServers combines file and inline servers", () => {
  const file: McpServerConfig[] = [
    { name: "a", transport: { type: "http", url: "http://a" } },
  ];
  const inline: McpServerConfig[] = [
    { name: "b", transport: { type: "http", url: "http://b" } },
  ];
  assertEquals(mergeMcpServers(file, inline).map((s) => s.name), ["a", "b"]);
});

Deno.test("mergeMcpServers lets inline override file for same name", () => {
  const file: McpServerConfig[] = [
    { name: "shared", transport: { type: "http", url: "http://file" } },
  ];
  const inline: McpServerConfig[] = [
    { name: "shared", transport: { type: "http", url: "http://inline" } },
  ];
  const merged = mergeMcpServers(file, inline);
  assertEquals(merged.length, 1);
  assertEquals(merged[0]!.transport, { type: "http", url: "http://inline" });
});

Deno.test("mergeMcpServers returns file-only when no inline specs", () => {
  const file: McpServerConfig[] = [
    { name: "a", transport: { type: "http", url: "http://a" } },
  ];
  assertEquals(mergeMcpServers(file, []), file);
});

Deno.test("mergeMcpServers returns inline-only when no file servers", () => {
  const inline: McpServerConfig[] = [
    { name: "b", transport: { type: "http", url: "http://b" } },
  ];
  assertEquals(mergeMcpServers([], inline), inline);
});

Deno.test("mergeMcpServers returns empty for both empty", () => {
  assertEquals(mergeMcpServers([], []), []);
});

// ---------------------------------------------------------------------------
// resolveMcpConfig
// ---------------------------------------------------------------------------

Deno.test("resolveMcpConfig returns empty when no config or inline specs", async () => {
  assertEquals(await resolveMcpConfig(undefined, []), []);
});

Deno.test("resolveMcpConfig reads a config file only", async () => {
  const { path, cleanup } = await writeConfig(JSON.stringify({
    "srv": { type: "http", url: "https://mcp.example.com" },
  }));
  try {
    const servers = await resolveMcpConfig(path, []);
    assertEquals(servers.map((s) => s.name), ["srv"]);
  } finally {
    await cleanup();
  }
});

Deno.test("resolveMcpConfig uses inline specs only", async () => {
  const servers = await resolveMcpConfig(undefined, [
    "a=url:http://a",
    "b=command:npx -y foo",
  ]);
  assertEquals(servers.map((s) => s.name), ["a", "b"]);
});

Deno.test("resolveMcpConfig merges file and inline, inline wins on conflict", async () => {
  const { path, cleanup } = await writeConfig(JSON.stringify({
    "shared": { type: "http", url: "http://file" },
    "file-only": { type: "http", url: "http://fo" },
  }));
  try {
    const servers = await resolveMcpConfig(path, [
      "shared=url:http://inline",
      "inline-only=url:http://io",
    ]);
    const byName = new Map(servers.map((s) => [s.name, s]));
    assertEquals(servers.length, 3);
    assertEquals(
      (byName.get("shared")!.transport as { url: string }).url,
      "http://inline",
    );
    assertEquals(byName.has("file-only"), true);
    assertEquals(byName.has("inline-only"), true);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// resolveMcpServers — success path with a real stdio MCP server
// ---------------------------------------------------------------------------

/** Path to the minimal MCP echo server fixture. */
const ECHO_SERVER = join(import.meta.dirname!, "..", "testdata", "mcp_echo_server.ts");

Deno.test("resolveMcpServers connects to a stdio MCP server and lists tools", async () => {
  const servers: McpServerConfig[] = [{
    name: "echo-server",
    transport: { type: "stdio", command: "deno", args: ["run", "-A", ECHO_SERVER] },
  }];
  const { connections, tools } = await resolveMcpServers(servers);
  try {
    assertEquals(connections.length, 1);
    // The tool name is prefixed with the server name by @huuma/ai.
    assertEquals(tools.length, 1);
    assertStringIncludes(tools[0]!.name, "echo");
  } finally {
    await closeMcpConnections(connections);
  }
});

Deno.test("resolveMcpServers returns empty connections and tools for no servers", async () => {
  const { connections, tools } = await resolveMcpServers([]);
  assertEquals(connections, []);
  assertEquals(tools, []);
});

Deno.test("resolveMcpServers fail-fast on connection error", async () => {
  const servers: McpServerConfig[] = [{
    name: "bad-server",
    transport: { type: "stdio", command: "nonexistent-command-xyz", args: [] },
  }];
  await assertRejects(
    () => resolveMcpServers(servers),
    Error,
    'MCP server "bad-server" failed to connect',
  );
});

Deno.test("resolveMcpServers skips optional servers on connection failure", async () => {
  const servers: McpServerConfig[] = [
    {
      name: "bad-optional",
      transport: { type: "stdio", command: "nonexistent-command-xyz", args: [] },
      optional: true,
    },
  ];
  const { connections, tools } = await resolveMcpServers(servers);
  assertEquals(connections, []);
  assertEquals(tools, []);
});

Deno.test("resolveMcpServers closes already-open connections on fail-fast", async () => {
  // One good server then one bad server — the bad one triggers fail-fast,
  // and the good connection must be closed before the error propagates.
  const servers: McpServerConfig[] = [
    {
      name: "good",
      transport: { type: "stdio", command: "deno", args: ["run", "-A", ECHO_SERVER] },
    },
    {
      name: "bad",
      transport: { type: "stdio", command: "nonexistent-command-xyz", args: [] },
    },
  ];
  await assertRejects(
    () => resolveMcpServers(servers),
    Error,
    'MCP server "bad" failed to connect',
  );
  // If the good connection was not closed, the subprocess would linger —
  // we can't assert that directly, but the test passing without hanging
  // proves the connections were cleaned up.
});

// ---------------------------------------------------------------------------
// closeMcpConnections
// ---------------------------------------------------------------------------

Deno.test("closeMcpConnections is a no-op for an empty array", async () => {
  await closeMcpConnections([]);
});

Deno.test("closeMcpConnections closes all connections", async () => {
  let closedCount = 0;
  const fakeConnections = [
    { close: () => { closedCount++; return Promise.resolve(); } },
    { close: () => { closedCount++; return Promise.resolve(); } },
  ];
  await closeMcpConnections(fakeConnections as never);
  assertEquals(closedCount, 2);
});

Deno.test("closeMcpConnections logs but does not throw on close failure", async () => {
  const { warn } = console;
  const warnings: string[] = [];
  console.warn = (msg: unknown) => warnings.push(String(msg));
  try {
    const fakeConnections = [
      { close: () => Promise.reject(new Error("close failed")) },
      { close: () => Promise.resolve() },
    ];
    await closeMcpConnections(fakeConnections as never);
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0]!, "close failed");
  } finally {
    console.warn = warn;
  }
});