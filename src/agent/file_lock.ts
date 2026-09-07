import { editFile, tool, type ToolContext } from "@huuma/ai/tools";
import { resolve } from "@std/path";

/**
 * Per-path locks serializing file-mutating tool calls.
 *
 * The agent executes every tool call in a model message concurrently
 * (`Promise.allSettled` in @huuma/ai's `callTool`), and each `edit_file` call
 * is a read-modify-write cycle. Two same-file edits issued together therefore
 * raced: the second write was computed against the pre-edit snapshot and
 * clobbered the first (lost update), `insert_lines` positions landed offset by
 * earlier dropped edits, and interleaved writes could append stray fragments
 * (spec #93). Holding a lock per resolved path across the whole cycle makes
 * same-file edits apply sequentially against current disk state.
 */
const locks = new Map<string, Promise<unknown>>();

/** Runs `fn` while holding an exclusive lock on `path`. Calls for the same
 * resolved path run sequentially in issue order; different paths never block.
 * A rejected section passes its error to its own caller only — later sections
 * still run. */
export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = resolve(path);
  const previous = locks.get(key) ?? Promise.resolve();
  // Detach from the previous section's failure so a rejected edit cannot
  // reject the chain itself and wedge later callers.
  const run = previous.catch(() => {}).then(fn);
  locks.set(key, run);
  try {
    return await run;
  } finally {
    // Only the newest chain may clean up; older sections are already superseded.
    if (locks.get(key) === run) locks.delete(key);
  }
}

/** The library's `edit_file` tool type. */
export type EditFileTool = ReturnType<typeof editFile>;

/** The library's `edit_file` tool with the per-path lock applied. */
export function lockedEditFile(): EditFileTool {
  return withEditFileLock(editFile());
}

/** Wraps the library's `edit_file` tool so every call runs inside the
 * per-path lock. Metadata, schema, and result shape are unchanged — only the
 * execution is serialized. */
export function withEditFileLock(edit: EditFileTool): EditFileTool {
  return tool({
    name: edit.name,
    description: edit.description,
    input: edit.input,
    timeout: edit.timeout,
    fn: async (props, context: ToolContext) => {
      const path = (props as { path: string }).path;
      return await withFileLock(path, () =>
        edit.call(props, { signal: context.signal }));
    },
  });
}