/**
 * Minimal MCP server for testing — speaks just enough of the JSON-RPC 2.0
 * / MCP protocol over stdio to satisfy `@huuma/ai/tools`'s `mcp()` client.
 *
 * Exposes one tool: `echo`, which returns its input text.
 */
// Read JSON-RPC messages from stdin, respond on stdout.
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const buf = new Uint8Array(65536);

/** Sends a JSON-RPC response or notification on stdout. */
function send(msg: unknown): void {
  Deno.stdout.writeSync(encoder.encode(JSON.stringify(msg) + "\n"));
}

// Track whether we've received the initialize request.
let initialized = false;

while (true) {
  const n = await Deno.stdin.read(buf);
  if (n === null) break;
  const text = decoder.decode(buf.subarray(0, n));
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    // Respond to initialize
    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "test-mcp-server", version: "1.0.0" },
        },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      initialized = true;
      continue;
    }

    // Respond to tools/list
    if (msg.method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [{
            name: "echo",
            description: "Echoes the input text back",
            inputSchema: {
              type: "object",
              properties: {
                text: { type: "string" },
              },
              required: ["text"],
            },
          }],
        },
      });
      continue;
    }

    // Respond to tools/call
    if (msg.method === "tools/call") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: "echoed" }],
        },
      });
      continue;
    }
  }
}