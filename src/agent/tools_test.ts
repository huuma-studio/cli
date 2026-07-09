import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
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
