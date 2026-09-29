import { assert, assertEquals } from "@std/assert";
import {
  emitDiagnostic,
  reportAgentError,
  sanitizeDiagnostic,
  UNAVAILABLE_DIAGNOSTIC,
} from "./diagnostics.ts";
import { CallbackError, sanitizeError } from "./managed/callback.ts";
import type { LogEntry } from "./managed/log_shipper.ts";
import { withEnv } from "./testing.ts";

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

Deno.test("reportAgentError ships a log-sanitized entry while callbacks keep sanitizeError", () => {
  const entries: LogEntry[] = [];
  const error = new Error(
    "request to https://api.example/v1?token=abc failed: password=hunter2",
  );
  const message = reportAgentError(
    "managed",
    "agent.run",
    error,
    () => {},
    (entry) => entries.push(entry),
  );
  // The callback text is exactly the existing sanitizer's output.
  assertEquals(message, sanitizeError(error));
  assertEquals(entries, [{
    level: "error",
    message:
      "request to https://api.example/v1?[redacted] failed: password=[redacted]",
    scope: "managed",
    stage: "agent.run",
    context: undefined,
  }]);
});

Deno.test("reportAgentError guards the console and structured sinks independently", () => {
  const entries: LogEntry[] = [];
  const message = reportAgentError(
    "managed",
    "config",
    new Error("config failed"),
    () => {
      throw new Error("console broken");
    },
    (entry) => entries.push(entry),
    { exit_code: 1 },
  );
  assertEquals(message, "config failed");
  assertEquals(entries.length, 1);
  assertEquals(entries[0].stage, "config");
  assertEquals(entries[0].context, { exit_code: 1 });

  const logged: string[] = [];
  const again = reportAgentError(
    "managed",
    "setup",
    new Error("setup failed"),
    (line) => logged.push(line),
    () => {
      throw new Error("sink broken");
    },
  );
  assertEquals(again, "setup failed");
  assertEquals(logged, ["[managed:setup] setup failed"]);
});

Deno.test("emitDiagnostic tags callback failures with their kind", () => {
  const entries: LogEntry[] = [];
  emitDiagnostic(
    (entry) => entries.push(entry),
    "error",
    "managed",
    "callback.turn_running",
    new CallbackError("budget-exhausted", "callback deadline budget exhausted"),
  );
  assertEquals(entries[0].context, { callback_kind: "budget-exhausted" });
  // No sink: nothing happens and nothing throws.
  emitDiagnostic(undefined, "warn", "managed", "mcp.close", "x");
});

Deno.test("sanitizeDiagnostic keeps the existing Authorization, Bearer, and provider-key heuristics", () => {
  assertEquals(
    sanitizeDiagnostic(
      "failed\nAuthorization: Bearer abc.def\nBearer xyz and sk-live-123",
      [],
    ),
    "failed\nBearer [redacted] and sk-[redacted]",
  );
});

Deno.test("sanitizeDiagnostic removes URL userinfo, query strings, and fragments", () => {
  assertEquals(
    sanitizeDiagnostic(
      "GET https://user:pw@api.example.com/v1/x?token=a&b=c#frag failed",
      [],
    ),
    "GET https://[redacted]@api.example.com/v1/x?[redacted] failed",
  );
  assertEquals(
    sanitizeDiagnostic("see http://host/path#section", []),
    "see http://host/path#[redacted]",
  );
  assertEquals(
    sanitizeDiagnostic("plain https://host.example/path stays", []),
    "plain https://host.example/path stays",
  );
});

Deno.test("sanitizeDiagnostic redacts short and punctuated credential assignments", () => {
  for (
    const [input, expected] of [
      ["token=a", "token=[redacted]"],
      [
        "access_token=x.y&refresh-token=z",
        "access_token=[redacted]&refresh-token=[redacted]",
      ],
      ["Password: p@ss!, next", "Password: [redacted], next"],
      ["secret='s p a c e'", "secret=[redacted]"],
      ['CLIENT_SECRET="q\\"x"', "CLIENT_SECRET=[redacted]"],
      [
        "credential=c1 credentials=c2",
        "credential=[redacted] credentials=[redacted]",
      ],
      [
        "api_key=k api-key=k APIKEY=k",
        "api_key=[redacted] api-key=[redacted] APIKEY=[redacted]",
      ],
      ["X-Api-Key: k1", "X-Api-Key: [redacted]"],
      ["HUUMA_SPECS_API_TOKEN=abc", "HUUMA_SPECS_API_TOKEN=[redacted]"],
    ]
  ) {
    assertEquals(sanitizeDiagnostic(input, []), expected, input);
  }
});

Deno.test("sanitizeDiagnostic redacts JSON-style credential assignments", () => {
  assertEquals(
    sanitizeDiagnostic(
      'body {"password": "p@ss!", "api_key": 12, "Token":"t", "name":"ok"}',
      [],
    ),
    'body {"password": [redacted], "api_key": [redacted], "Token":[redacted], "name":"ok"}',
  );
});

Deno.test("sanitizeDiagnostic replaces exact known credential values and placeholders", async () => {
  assertEquals(
    sanitizeDiagnostic("leaked k!y and k!y2 here", ["k!y", "k!y2"]),
    "leaked [redacted] and [redacted] here",
  );
  await withEnv({
    HUUMA_SPECS_API_TOKEN: "placeholder-specs",
    HUUMA_AGENT_CALLBACK_SECRET: "cb.secret",
    BRAVE_API_KEY: null,
  }, () => {
    assertEquals(
      sanitizeDiagnostic(
        new Error("sent placeholder-specs with cb.secret to host"),
      ),
      "sent [redacted] with [redacted] to host",
    );
  });
});

Deno.test("sanitizeDiagnostic bounds output to 1,024 UTF-8 bytes on a code-point boundary", () => {
  const message = sanitizeDiagnostic("€".repeat(600), []);
  assert(new TextEncoder().encode(message).byteLength <= 1024);
  assertEquals(message, "€".repeat(341));
});

Deno.test("sanitizeDiagnostic falls back to a fixed message on hostile coercion", () => {
  const hostileToString = {
    toString() {
      throw new Error("token=leak");
    },
  };
  const hostileMessage = new Error("x");
  Object.defineProperty(hostileMessage, "message", {
    get() {
      throw new Error("token=leak");
    },
  });
  const hostileProxy = new Proxy({}, {
    getPrototypeOf() {
      throw new Error("token=leak");
    },
  });
  for (const value of [hostileToString, hostileMessage, hostileProxy]) {
    assertEquals(sanitizeDiagnostic(value, []), UNAVAILABLE_DIAGNOSTIC);
  }
});
