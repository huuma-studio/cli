import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { withEnv } from "./testing.ts";
import { resolveTools } from "./tools.ts";

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

Deno.test("resolveTools expands skills into list_skills and retrieve_skill", () => {
  assertEquals(toolNames(["skills"]), ["list_skills", "retrieve_skill"]);
});

Deno.test("resolveTools wires --skills-path into the scan directory", async () => {
  // Build a throwaway skills tree the factory will scan.
  const root = await Deno.makeTempDir();
  try {
    const skillDir = join(root, "mcp-builder");
    await Deno.mkdir(skillDir);
    await Deno.writeTextFile(
      join(skillDir, "SKILL.md"),
      "---\nname: mcp-builder\ndescription: builds MCP servers\n---\n# mcp-builder\n",
    );

    const tools = resolveTools(["skills"], { skillsPath: root }).tools;
    const list = tools.find((t) => t.name === "list_skills")!;
    const retrieve = tools.find((t) => t.name === "retrieve_skill")!;

    assertEquals(await list.call({}), [{
      name: "mcp-builder",
      description: "builds MCP servers",
    }]);
    const loaded = (await retrieve.call({ name: "mcp-builder" })) as {
      instructions: string;
      name: string;
    };
    assertStringIncludes(loaded.instructions, "# mcp-builder");
    assertEquals(loaded.name, "mcp-builder");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("resolveTools skills are lenient about a missing directory", async () => {
  // A nonexistent path yields an empty list rather than throwing, so the
  // always-on baseline costs nothing in a project with no skills (ADR 0009).
  const tools =
    resolveTools(["skills"], { skillsPath: "./nope-does-not-exist" })
      .tools;
  const list = tools.find((t) => t.name === "list_skills")!;
  assertEquals(await list.call({}), []);
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

Deno.test("resolveTools wires the cli allow-list from --cli-commands", () => {
  const [tool, ...rest] =
    resolveTools(["cli"], { cliCommands: ["deno", "git"] }).tools;
  assertEquals(rest, []);
  assertEquals(tool.name, "cli");
  // The allow-list surfaces in the description the model sees.
  assertEquals(tool.description.includes("deno, git"), true);
});

Deno.test("resolveTools requires an allow-list for the cli tool", () => {
  assertThrows(() => resolveTools(["cli"]), Error, "--cli-commands");
  assertThrows(
    () => resolveTools(["cli"], { cliCommands: [] }),
    Error,
    "--cli-commands",
  );
});

Deno.test("resolveTools builds search from --search-engine, case-insensitively", () => {
  assertEquals(
    resolveTools(["search"], { searchEngine: "Brave" }).tools.map((t) =>
      t.name
    ),
    ["search"],
  );
});

Deno.test("resolveTools requires an engine for the search tool", () => {
  assertThrows(() => resolveTools(["search"]), Error, "--search-engine");
  assertThrows(
    () => resolveTools(["search"], { searchEngine: "bing" }),
    Error,
    "--search-engine",
  );
});

// Pins ADR 0008: the env vars the flags replaced must stay dead — a value an
// agent smuggles into the environment cannot configure a tool.
Deno.test("resolveTools ignores the removed env vars", async () => {
  await withEnv(
    {
      HUUMA_AGENT_CLI_COMMANDS: "bash",
      HUUMA_AGENT_SEARCH_ENGINE: "brave",
    },
    () => {
      assertThrows(() => resolveTools(["cli"]), Error, "--cli-commands");
      assertThrows(() => resolveTools(["search"]), Error, "--search-engine");
    },
  );
});
