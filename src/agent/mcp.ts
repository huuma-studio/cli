import { mcp, type McpConnection, type McpToolsOptions } from "@huuma/ai/tools";
import type { AgentOptions } from "@huuma/ai/agent";

// Re-export so other modules can import McpConnection from a single location.
export type { McpConnection };

/** The agent's tool array type, matching `AgentTools` from `tools.ts`. */
type AgentTools = NonNullable<AgentOptions<string>["tools"]>;

/** Transport for a stdio MCP server: an executable and its arguments, passed
 * to the subprocess directly (no shell). */
export interface McpStdioTransport {
  type: "stdio";
  command: string;
  args: string[];
}

/** Transport for an HTTP MCP server: a URL the client connects to. */
export interface McpHttpTransport {
  type: "http";
  url: string;
}

/** The transport for an MCP server connection. */
export type McpTransport = McpStdioTransport | McpHttpTransport;

/** One entry in the MCP server configuration. `optional` controls whether a
 * connection failure is fatal (default) or logged and skipped. */
export interface McpServerConfig {
  name: string;
  transport: McpTransport;
  /** When `true`, a connection failure logs a warning and skips the server
   * instead of throwing (fail-fast by default). */
  optional?: boolean;
}

/** Outcome of {@link resolveMcpServers}: the open connections (for lifecycle
 * cleanup) and the merged tool arrays from every connected server. */
export interface ResolvedMcp {
  connections: McpConnection[];
  tools: AgentTools;
}

/** Default config file path. Users can override with `--mcp-config`. */
export const DEFAULT_MCP_CONFIG_PATH = ".huuma/mcp.json";

/** Validates a server name: non-empty, alphanumeric + hyphens/underscores,
 * starts with a letter. Delegates to `@huuma/ai`'s `validateServerName` at
 * connection time, but this catches obviously invalid names early during
 * parse so a typo doesn't surface as a connection error. */
const SERVER_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

function validateServerNameEarly(name: string): void {
  if (!SERVER_NAME_RE.test(name)) {
    throw new Error(
      `Invalid MCP server name "${name}". Names must start with a letter ` +
        "and contain only letters, digits, hyphens, and underscores.",
    );
  }
}

/** Reads and validates a JSON config file mapping server names to transport
 * config. Returns a typed {@link McpServerConfig}[]. Throws on missing files,
 * malformed JSON, or invalid entries. */
export async function parseMcpConfig(
  path: string,
): Promise<McpServerConfig[]> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    throw new Error(
      `Cannot read MCP config file at "${path}". Check the path passed to ` +
        "--mcp-config.",
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `MCP config file "${path}" is not valid JSON: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error(
      `MCP config file "${path}" must be a JSON object mapping server names ` +
        "to transport configurations.",
    );
  }

  const entries = Object.entries(json as Record<string, unknown>);
  const servers: McpServerConfig[] = [];
  for (const [name, raw] of entries) {
    validateServerNameEarly(name);
    servers.push(parseServerEntry(name, raw, path));
  }
  return servers;
}

/** Parses a single server entry from the config file. */
function parseServerEntry(
  name: string,
  raw: unknown,
  path: string,
): McpServerConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `MCP server "${name}" in "${path}" must be an object with a transport.`,
    );
  }
  const obj = raw as Record<string, unknown>;
  const optional = obj.optional === true;

  // stdio transport
  if (
    obj.type === "stdio" || (obj.command !== undefined && obj.url === undefined)
  ) {
    const command = obj.command;
    if (typeof command !== "string" || command.trim() === "") {
      throw new Error(
        `MCP server "${name}" in "${path}" has a stdio transport but ` +
          `"command" is missing or not a string.`,
      );
    }
    const args = obj.args;
    if (args !== undefined && !Array.isArray(args)) {
      throw new Error(
        `MCP server "${name}" in "${path}" has "args" that is not an array.`,
      );
    }
    if (Array.isArray(args) && args.some((a) => typeof a !== "string")) {
      throw new Error(
        `MCP server "${name}" in "${path}" has non-string elements in "args".`,
      );
    }
    const existingArgs = (args as string[]) ?? [];
    // A command containing whitespace (e.g. "npx -y @some/mcp-server") was
    // likely entered as a single value instead of being split into command +
    // args. Preserve it only when the complete value identifies a real file,
    // which disambiguates executable paths containing spaces from commands
    // such as "/usr/bin/npx -y @some/mcp-server".
    const needsTokenization = hasWhitespace(command) &&
      !isExistingFile(command);
    const [resolvedCommand, ...tokenizedArgs] = needsTokenization
      ? tokenizeStdioCommand(command)
      : [command];
    return {
      name,
      transport: {
        type: "stdio",
        command: resolvedCommand!,
        args: [...tokenizedArgs, ...existingArgs],
      },
      optional,
    };
  }

  // http transport
  if (obj.type === "http" || obj.url !== undefined) {
    const url = obj.url;
    if (typeof url !== "string" || url.trim() === "") {
      throw new Error(
        `MCP server "${name}" in "${path}" has an http transport but ` +
          `"url" is missing or not a string.`,
      );
    }
    return {
      name,
      transport: { type: "http", url },
      optional,
    };
  }

  throw new Error(
    `MCP server "${name}" in "${path}" is missing a transport. Provide ` +
      '"type": "stdio" with "command"/"args", or "type": "http" with "url".',
  );
}

/** Parses an inline `--mcp-server name=spec` flag value.
 *
 * Two forms are supported:
 * - `name=command:cmd args` (stdio — the command after `command:` is
 *   tokenized with shell-quoting rules)
 * - `name=url:url` (http — no special tokenization)
 *
 * The `name` is validated early. Returns a typed {@link McpServerConfig}. */
export function parseInlineMcpServer(value: string): McpServerConfig {
  const eq = value.indexOf("=");
  if (eq === -1) {
    throw new Error(
      `Invalid --mcp-server value "${value}". Expected name=spec, e.g. ` +
        "myserver=command:npx -y @some/mcp-server or " +
        "myserver=url:http://localhost:3000",
    );
  }
  const name = value.slice(0, eq);
  const spec = value.slice(eq + 1);
  if (!name) {
    throw new Error(
      `Invalid --mcp-server value "${value}". The server name before "=" ` +
        "is empty.",
    );
  }
  validateServerNameEarly(name);

  // stdio: name=command:<cmd string>
  const commandPrefix = "command:";
  if (spec.startsWith(commandPrefix)) {
    const cmdString = spec.slice(commandPrefix.length);
    if (!cmdString.trim()) {
      throw new Error(
        `Invalid --mcp-server value for "${name}": the command after ` +
          '"command:" is empty.',
      );
    }
    const tokens = tokenizeStdioCommand(cmdString);
    if (tokens.length === 0) {
      throw new Error(
        `Invalid --mcp-server value for "${name}": the command after ` +
          '"command:" produced no tokens.',
      );
    }
    const [command, ...args] = tokens;
    return {
      name,
      transport: { type: "stdio", command: command!, args },
    };
  }

  // http: name=url:<url>
  const urlPrefix = "url:";
  if (spec.startsWith(urlPrefix)) {
    const url = spec.slice(urlPrefix.length);
    if (!url.trim()) {
      throw new Error(
        `Invalid --mcp-server value for "${name}": the URL after "url:" ` +
          "is empty.",
      );
    }
    return {
      name,
      transport: { type: "http", url },
    };
  }

  throw new Error(
    `Invalid --mcp-server value for "${name}": the spec must start with ` +
      '"command:" (stdio) or "url:" (http). Received: ' + spec,
  );
}

/** Tokenizes a stdio command string using shell-quoting rules.
 *
 * Single- and double-quoted segments are supported; backslash escapes spaces
 * within quotes. The first token is the executable; remaining tokens form the
 * args array. The executable and args are passed to the subprocess directly
 * (no shell), so shell injection is not possible. */
export function tokenizeStdioCommand(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    // Skip whitespace between tokens
    while (i < len && isWhitespace(input[i]!)) i++;
    if (i >= len) break;

    let token = "";
    while (i < len && !isWhitespace(input[i]!)) {
      const ch = input[i]!;

      if (ch === "'") {
        // Single-quoted: everything until the closing single quote is literal
        i++; // skip opening quote
        while (i < len && input[i] !== "'") {
          token += input[i]!;
          i++;
        }
        if (i >= len) {
          throw new Error(
            `Unterminated single quote in command: "${input}"`,
          );
        }
        i++; // skip closing quote
        continue;
      }

      if (ch === '"') {
        // Double-quoted: backslash escapes the next char (space, quote, etc.)
        i++; // skip opening quote
        while (i < len && input[i] !== '"') {
          if (input[i] === "\\") {
            i++; // skip backslash
            if (i < len) {
              token += input[i]!;
            }
          } else {
            token += input[i]!;
          }
          i++;
        }
        if (i >= len) {
          throw new Error(
            `Unterminated double quote in command: "${input}"`,
          );
        }
        i++; // skip closing quote
        continue;
      }

      if (ch === "\\") {
        // Backslash outside quotes: escape the next character
        i++; // skip backslash
        if (i < len) {
          token += input[i]!;
        }
        i++;
        continue;
      }

      // Unquoted literal character
      token += ch;
      i++;
    }
    tokens.push(token);
  }

  return tokens;
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function hasWhitespace(value: string): boolean {
  for (const ch of value) {
    if (isWhitespace(ch)) return true;
  }
  return false;
}

function isExistingFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/** Merges servers from a config file with inline `--mcp-server` specs.
 * Inline specs override file entries with the same name (the duplicate is
 * resolved at merge time and a warning is logged naming the overridden
 * server). Returns a single {@link McpServerConfig}[] with no duplicate
 * names. */
export function mergeMcpServers(
  fileServers: McpServerConfig[],
  inlineServers: McpServerConfig[],
): McpServerConfig[] {
  const byName = new Map<string, McpServerConfig>();
  for (const server of fileServers) {
    byName.set(server.name, server);
  }
  for (const server of inlineServers) {
    if (byName.has(server.name)) {
      console.warn(
        `MCP server "${server.name}" from --mcp-server overrides the ` +
          "entry from the config file.",
      );
    }
    byName.set(server.name, server);
  }
  return [...byName.values()];
}

/** Resolves MCP config from both a file and inline specs, returning a single
 * merged {@link McpServerConfig}[]. When `configPath` is absent, the default
 * config is read when present. A missing default is ignored; an explicit path
 * remains strict. */
export async function resolveMcpConfig(
  configPath: string | undefined,
  inlineSpecs: string[],
): Promise<McpServerConfig[]> {
  const fileServers: McpServerConfig[] = [];
  const resolvedPath = configPath ?? DEFAULT_MCP_CONFIG_PATH;
  if (configPath || await pathExists(resolvedPath)) {
    fileServers.push(...await parseMcpConfig(resolvedPath));
  }
  const inlineServers = inlineSpecs.map((spec) => parseInlineMcpServer(spec));
  return mergeMcpServers(fileServers, inlineServers);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** Connects to all configured MCP servers, collects {@link McpConnection}
 * handles, and returns their merged tools.
 *
 * For each server config, calls `mcp()` from `@huuma/ai/tools`. By default a
 * connection failure throws (fail-fast). When `optional: true` is set on a
 * server config, the failure is logged and the server is skipped.
 *
 * Returns `{ connections, tools }` where `connections` are the open handles
 * (for lifecycle cleanup) and `tools` is the flat array of tools from every
 * connected server. */
export async function resolveMcpServers(
  servers: McpServerConfig[],
): Promise<ResolvedMcp> {
  const connections: McpConnection[] = [];
  const tools: AgentTools = [];

  for (const server of servers) {
    const options: McpToolsOptions = toMcpToolsOptions(server);
    try {
      const conn = await mcp(options);
      connections.push(conn);
      tools.push(...conn.tools());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (server.optional) {
        console.warn(
          `MCP server "${server.name}" (optional) failed to connect and ` +
            `was skipped: ${message}`,
        );
        continue;
      }
      // Fail-fast: close already-open connections before throwing so no
      // resources leak.
      await closeMcpConnections(connections);
      throw new Error(
        `MCP server "${server.name}" failed to connect: ${message}`,
      );
    }
  }

  return { connections, tools };
}

/** Translates a {@link McpServerConfig} to the `McpToolsOptions` shape
 * expected by `mcp()` from `@huuma/ai/tools`. */
function toMcpToolsOptions(server: McpServerConfig): McpToolsOptions {
  return {
    name: server.name,
    transport: server.transport,
  };
}

/** Closes all connections, best-effort. Individual `close()` failures are
 * logged but never throw. Safe to call on an empty array. */
export async function closeMcpConnections(
  connections: McpConnection[],
): Promise<void> {
  for (const conn of connections) {
    try {
      await conn.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`MCP connection close failed: ${message}`);
    }
  }
}
