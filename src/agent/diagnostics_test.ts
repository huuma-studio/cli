import { assertEquals } from "@std/assert";
import { reportAgentError } from "./diagnostics.ts";

Deno.test("reportAgentError identifies the boundary and sanitizes secrets", () => {
  const errors: string[] = [];
  const message = reportAgentError(
    "managed",
    "agent.run",
    new Error("provider rejected Bearer abc.def.ghi"),
    (diagnostic) => errors.push(diagnostic),
  );

  assertEquals(message, "provider rejected Bearer [redacted]");
  assertEquals(errors, [
    "[managed:agent.run] provider rejected Bearer [redacted]",
  ]);
});

Deno.test("reportAgentError ignores a broken diagnostic sink", () => {
  const message = reportAgentError(
    "agent",
    "setup",
    new Error("setup failed"),
    () => {
      throw new Error("logger failed");
    },
  );

  assertEquals(message, "setup failed");
});
