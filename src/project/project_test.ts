import { assertStringIncludes } from "@std/assert";
import project from "./project.ts";

// --help must short-circuit before the interactive prompts, so these run
// without any stdin or file-system access.
Deno.test("project --help returns usage without prompting", async () => {
  const result = await project(["--help"]);
  assertStringIncludes(result, "huuma project [OPTIONS]");
  assertStringIncludes(result, "website"); // a registered project type
});

Deno.test("project -h returns the same usage", async () => {
  assertStringIncludes(await project(["-h"]), "huuma project [OPTIONS]");
});
