import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { SpecsPermission } from "./specs.ts";
import { SPECS_PERMISSIONS, SPECS_TOKEN_ENV, specsTools } from "./specs.ts";
import { resolveTools } from "./tools.ts";
import { withEnv } from "./testing.ts";

/** All six permissions, in declaration order. */
const ALL_PERMISSIONS = [...SPECS_PERMISSIONS];

/** Valid UUID-shaped sentinel IDs so the tool's `uuid()` validation passes and
 * the request reaches the test server, which routes on the full UUID. */
const SPEC_ID = "11111111-1111-1111-1111-111111111111";
const TASK_ID = "22222222-2222-2222-2222-222222222222";
const MISSING_SPEC = "33333333-3333-3333-3333-333333333333";
const FORBIDDEN_SPEC = "44444444-4444-4444-4444-444444444444";
const UNAUTH_SPEC = "55555555-5555-5555-5555-555555555555";
const BOOM_SPEC = "66666666-6666-6666-6666-666666666666";
const MISSING_TASK = "77777777-7777-7777-7777-777777777777";
const FORBIDDEN_TASK = "88888888-8888-8888-8888-888888888888";

/** Starts a local HTTP server implementing the Studio internal specs API and
 * returns its base URL plus a shutdown handle. The handler records every
 * request's method, path, Authorization header, and parsed body so tests can
 * assert what the runner sent. */
async function startServer(): Promise<{
  base: string;
  requests: RequestLog[];
  shutdown: () => Promise<void>;
}> {
  const requests: RequestLog[] = [];
  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const log: RequestLog = {
      method: req.method,
      path: url.pathname,
      auth: req.headers.get("Authorization") ?? "",
      body: await readJsonBody(req),
    };
    requests.push(log);
    return route(req, url, log);
  };
  const server = Deno.serve({ port: 0, onListen: () => {} }, handler);
  const addr = server.addr as Deno.NetAddr;
  const base = `http://localhost:${addr.port}`;
  return {
    base,
    requests,
    shutdown: () => server.shutdown(),
  };
}

interface RequestLog {
  method: string;
  path: string;
  auth: string;
  body: unknown;
}

/** Reads the JSON body of a request, or `undefined` when there is none. */
async function readJsonBody(req: Request): Promise<unknown> {
  if (req.method === "GET" || req.headers.get("Content-Length") === "0") {
    return undefined;
  }
  const text = await req.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Routes one request to a deterministic response. Standard IDs return happy
 * paths; sentinel UUIDs exercise the error contract (404/403/401/5xx). */
function route(
  _req: Request,
  url: URL,
  log: RequestLog,
): Response {
  const { path } = log;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  if (path === "/specs" && log.method === "GET") {
    return json(200, [
      { id: SPEC_ID, number: 1, title: "Add dark mode", type: "feature", status: "open" },
    ]);
  }
  if (path.startsWith("/specs/") && log.method === "GET") {
    const id = path.slice("/specs/".length);
    const [specId, rest] = id.split("/");
    if (rest === "tasks") {
      return json(200, [taskFixture(specId, TASK_ID, 1, "Create toggle", "high", "open")]);
    }
    if (specId === MISSING_SPEC) return json(404, { error: "Spec not found" });
    if (specId === FORBIDDEN_SPEC) return json(403, { detail: "no access" });
    if (specId === UNAUTH_SPEC) return json(401, { detail: "bad token" });
    if (specId === BOOM_SPEC) return json(500, { error: "kaboom" });
    return json(200, {
      id: specId,
      number: 1,
      title: "Add dark mode",
      description_markdown: "## Overview\n\nImplement a dark mode toggle.",
      type: "feature",
      status: "open",
      tasks: [taskFixture(specId, TASK_ID, 1, "Create toggle", "high", "open")],
    });
  }
  if (path.startsWith("/specs/") && log.method === "PATCH") {
    const specId = path.slice("/specs/".length);
    if (specId === FORBIDDEN_SPEC) return json(403, { detail: "no access" });
    return json(200, {
      id: specId,
      number: 1,
      title: "Add dark mode",
      description_markdown: "## Updated",
      type: "feature",
      status: (log.body as { status?: string })?.status ?? "open",
      tasks: [],
    });
  }
  if (path.startsWith("/tasks/") && log.method === "GET") {
    const taskId = path.slice("/tasks/".length);
    if (taskId === MISSING_TASK) return json(404, { error: "Task not found" });
    if (taskId === FORBIDDEN_TASK) return json(403, { detail: "no access" });
    return json(200, taskFixture(SPEC_ID, taskId, 1, "Create toggle", "high", "open"));
  }
  if (path.startsWith("/tasks/") && log.method === "PATCH") {
    const taskId = path.slice("/tasks/".length);
    if (taskId === FORBIDDEN_TASK) return json(403, { detail: "no access" });
    return json(200, taskFixture(SPEC_ID, taskId, 1, "Create toggle", "high",
      (log.body as { status?: string })?.status ?? "open"));
  }
  return json(404, { error: `No route for ${log.method} ${path}` });
}

function taskFixture(
  specId: string,
  taskId: string,
  number: number,
  title: string,
  priority: string,
  status: string,
) {
  return {
    id: taskId,
    number,
    title,
    description_markdown: `Build ${title}.`,
    acceptance_criteria: ["It works"],
    priority,
    status,
    spec_id: specId,
  };
}

/** Builds the tools (with a token) for `permissions` against `base`. */
function buildTools(base: string, permissions: SpecsPermission[]) {
  return specsTools({ specsPermissions: permissions, specsApiUrl: base });
}

/** Calls a tool by name, returning its parsed output. */
async function call(
  tools: ReturnType<typeof specsTools>,
  name: string,
  props: unknown,
): Promise<unknown> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return await tool.call(props);
}

// ---------------------------------------------------------------------------
// Registration rules
// ---------------------------------------------------------------------------

Deno.test("specsTools registers nothing without permissions", async () => {
  await withEnv({ [SPECS_TOKEN_ENV]: "token" }, () => {
    assertEquals(specsTools({ specsPermissions: [], specsApiUrl: "https://x/api" }), []);
    assertEquals(specsTools({ specsApiUrl: "https://x/api" }), []);
  });
});

Deno.test("specsTools registers nothing when the token env is unset", async () => {
  // Permissions and URL present, but no HUUMA_SPECS_API_TOKEN: the runner must
  // not expose functions it cannot authenticate (RUNNER-CONTRACT criterion 7).
  await withEnv({ [SPECS_TOKEN_ENV]: null }, () => {
    assertEquals(
      specsTools({
        specsPermissions: ALL_PERMISSIONS,
        specsApiUrl: "https://x/api",
      }),
      [],
    );
  });
});

Deno.test("specsTools treats a missing token as empty permissions before validating", async () => {
  // Criterion 7: an unset token is "treat as if --specs-permissions was empty",
  // so a tokenless run never errors on a permission typo or a missing URL —
  // it simply exposes nothing.
  await withEnv({ [SPECS_TOKEN_ENV]: null }, () => {
    assertEquals(
      specsTools({ specsPermissions: ["spec:bogus"], specsApiUrl: "https://x/api" }),
      [],
    );
    assertEquals(specsTools({ specsPermissions: ["spec:list"] }), []);
  });
});

Deno.test("specsTools fails fast without --specs-api-url when permissions are granted", async () => {
  await withEnv({ [SPECS_TOKEN_ENV]: "token" }, () => {
    assertThrows(
      () => specsTools({ specsPermissions: ["spec:list"] }),
      Error,
      "The specs tool needs --specs-api-url",
    );
  });
});

Deno.test("specsTools rejects an unknown permission", async () => {
  await withEnv({ [SPECS_TOKEN_ENV]: "token" }, () => {
    assertThrows(
      () =>
        specsTools({
          specsPermissions: ["spec:list", "spec:bogus"],
          specsApiUrl: "https://x/api",
        }),
      Error,
      'Unknown specs permission "spec:bogus"',
    );
  });
});

Deno.test("specsTools exposes only the permitted functions", async () => {
  await withEnv({ [SPECS_TOKEN_ENV]: "token" }, () => {
    const tools = specsTools({
      specsPermissions: ["spec:list", "task:read"] as SpecsPermission[],
      specsApiUrl: "https://x/api",
    });
    assertEquals(tools.map((t) => t.name), ["list_specs", "read_task"]);
  });
});

Deno.test("specsTools exposes all six functions for full permissions", async () => {
  await withEnv({ [SPECS_TOKEN_ENV]: "token" }, () => {
    const tools = specsTools({
      specsPermissions: ALL_PERMISSIONS,
      specsApiUrl: "https://x/api",
    });
    assertEquals(
      tools.map((t) => t.name),
      ["list_specs", "read_spec", "update_spec", "list_tasks", "read_task", "update_task"],
    );
  });
});

Deno.test("resolveTools builds the specs tools from --tools specs", async () => {
  await withEnv({ [SPECS_TOKEN_ENV]: "token" }, () => {
    const { tools } = resolveTools(["specs"], {
      specsPermissions: ["spec:read"],
      specsApiUrl: "https://x/api",
    });
    assertEquals(tools.map((t) => t.name), ["read_spec"]);
  });
});

// ---------------------------------------------------------------------------
// HTTP behavior
// ---------------------------------------------------------------------------

Deno.test("list_specs returns the spec summaries", async () => {
  const server = await startServer();
  try {
    await withEnv({ [SPECS_TOKEN_ENV]: "secret-token" }, async () => {
      const tools = buildTools(server.base, ["spec:list"]);
      const result = await call(tools, "list_specs", {});
      assertEquals(result, [
        { id: SPEC_ID, number: 1, title: "Add dark mode", type: "feature", status: "open" },
      ]);
      // The Authorization header carries the token verbatim after "Bearer ".
      const expectedAuth = ["Bearer", "secret-token"].join(" ");
      assertEquals(server.requests[0].auth, expectedAuth);
      assertEquals(server.requests[0].method, "GET");
      assertEquals(server.requests[0].path, "/specs");
    });
  } finally {
    await server.shutdown();
  }
});

Deno.test("read_spec returns the spec with its tasks", async () => {
  const server = await startServer();
  try {
    await withEnv({ [SPECS_TOKEN_ENV]: "secret-token" }, async () => {
      const tools = buildTools(server.base, ["spec:read"]);
      const result = await call(tools, "read_spec", { spec_id: SPEC_ID }) as {
        id: string;
        tasks: unknown[];
      };
      assertEquals(result.id, SPEC_ID);
      assertEquals(result.tasks.length, 1);
      assertEquals(server.requests[0].path, `/specs/${SPEC_ID}`);
    });
  } finally {
    await server.shutdown();
  }
});

Deno.test("update_spec sends only the provided fields", async () => {
  const server = await startServer();
  try {
    await withEnv({ [SPECS_TOKEN_ENV]: "secret-token" }, async () => {
      const tools = buildTools(server.base, ["spec:update"]);
      const result = await call(tools, "update_spec", {
        spec_id: SPEC_ID,
        status: "in_progress",
      }) as { status: string };
      assertEquals(result.status, "in_progress");
      // Only `status` was provided, so the PATCH body must not contain null
      // or undefined placeholders for the other fields.
      assertEquals(server.requests[0].body, { status: "in_progress" });
      assertEquals(server.requests[0].method, "PATCH");
    });
  } finally {
    await server.shutdown();
  }
});

Deno.test("update_spec rejects a call with no fields", async () => {
  const server = await startServer();
  try {
    await withEnv({ [SPECS_TOKEN_ENV]: "secret-token" }, async () => {
      const tools = buildTools(server.base, ["spec:update"]);
      await assertRejects(
        () => call(tools, "update_spec", { spec_id: SPEC_ID }),
        Error,
        "update_spec requires at least one field",
      );
      // No request was made — the at-least-one rule fires before fetch.
      assertEquals(server.requests.length, 0);
    });
  } finally {
    await server.shutdown();
  }
});

Deno.test("list_tasks and read_task return task data", async () => {
  const server = await startServer();
  try {
    await withEnv({ [SPECS_TOKEN_ENV]: "secret-token" }, async () => {
      const tools = buildTools(server.base, ["task:list", "task:read"]);
      const tasks = await call(tools, "list_tasks", { spec_id: SPEC_ID }) as unknown[];
      assertEquals(tasks.length, 1);
      assertEquals(server.requests[0].path, `/specs/${SPEC_ID}/tasks`);
      const task = await call(tools, "read_task", { task_id: TASK_ID }) as { id: string };
      assertEquals(task.id, TASK_ID);
      assertEquals(server.requests[1].path, `/tasks/${TASK_ID}`);
    });
  } finally {
    await server.shutdown();
  }
});

Deno.test("update_task sends acceptance_criteria and provided fields", async () => {
  const server = await startServer();
  try {
    await withEnv({ [SPECS_TOKEN_ENV]: "secret-token" }, async () => {
      const tools = buildTools(server.base, ["task:update"]);
      const result = await call(tools, "update_task", {
        task_id: TASK_ID,
        status: "done",
        acceptance_criteria: ["One", "Two"],
      }) as { status: string };
      assertEquals(result.status, "done");
      assertEquals(server.requests[0].body, {
        status: "done",
        acceptance_criteria: ["One", "Two"],
      });
    });
  } finally {
    await server.shutdown();
  }
});

// ---------------------------------------------------------------------------
// Input validation (identifiers + closed value sets)
// ---------------------------------------------------------------------------

Deno.test("read_spec rejects a non-UUID spec_id without making a request", async () => {
  const server = await startServer();
  try {
    await withEnv({ [SPECS_TOKEN_ENV]: "secret-token" }, async () => {
      const tools = buildTools(server.base, ["spec:read"]);
      await assertRejects(
        () => call(tools, "read_spec", { spec_id: "not-a-uuid" }),
        Error,
        "is not a valid",
      );
      assertEquals(server.requests.length, 0);
    });
  } finally {
    await server.shutdown();
  }
});

Deno.test("read_spec rejects a spec_id containing path separators (no path injection)", async () => {
  // A slash inside the id would otherwise turn `specs/<id>` into a different
  // path. The UUID constraint rejects it before any fetch.
  const server = await startServer();
  try {
    await withEnv({ [SPECS_TOKEN_ENV]: "secret-token" }, async () => {
      const tools = buildTools(server.base, ["spec:read"]);
      await assertRejects(
        () =>
          call(tools, "read_spec", { spec_id: `${SPEC_ID}/evil/tasks` }),
        Error,
        "is not a valid",
      );
      assertEquals(server.requests.length, 0);
    });
  } finally {
    await server.shutdown();
  }
});

Deno.test("update_spec rejects an unsupported type value without a request", async () => {
  const server = await startServer();
  try {
    await withEnv({ [SPECS_TOKEN_ENV]: "secret-token" }, async () => {
      const tools = buildTools(server.base, ["spec:update"]);
      await assertRejects(
        () => call(tools, "update_spec", { spec_id: SPEC_ID, type: "epic" }),
        Error,
        "is not one of",
      );
      assertEquals(server.requests.length, 0);
    });
  } finally {
    await server.shutdown();
  }
});

Deno.test("update_spec rejects an unsupported status value (spec status set)", async () => {
  const server = await startServer();
  try {
    await withEnv({ [SPECS_TOKEN_ENV]: "secret-token" }, async () => {
      const tools = buildTools(server.base, ["spec:update"]);
      // "closed" is not a valid spec status; "draft" is valid for specs only.
      await assertRejects(
        () => call(tools, "update_spec", { spec_id: SPEC_ID, status: "closed" }),
        Error,
        "is not one of",
      );
      assertEquals(server.requests.length, 0);
    });
  } finally {
    await server.shutdown();
  }
});

Deno.test("update_spec accepts the spec-only draft status", async () => {
  const server = await startServer();
  try {
    await withEnv({ [SPECS_TOKEN_ENV]: "secret-token" }, async () => {
      const tools = buildTools(server.base, ["spec:update"]);
      const result = await call(tools, "update_spec", {
        spec_id: SPEC_ID,
        status: "draft",
      }) as { status: string };
      assertEquals(result.status, "draft");
      assertEquals(server.requests[0].body, { status: "draft" });
    });
  } finally {
    await server.shutdown();
  }
});

Deno.test("update_task rejects an unsupported priority and an unsupported status", async () => {
  const server = await startServer();
  try {
    await withEnv({ [SPECS_TOKEN_ENV]: "secret-token" }, async () => {
      const tools = buildTools(server.base, ["task:update"]);
      await assertRejects(
        () => call(tools, "update_task", { task_id: TASK_ID, priority: "urgent" }),
        Error,
        "is not one of",
      );
      // "draft" is a spec status, not a task status — rejected for tasks.
      await assertRejects(
        () => call(tools, "update_task", { task_id: TASK_ID, status: "draft" }),
        Error,
        "is not one of",
      );
      assertEquals(server.requests.length, 0);
    });
  } finally {
    await server.shutdown();
  }
});

Deno.test("read_task rejects a non-UUID task_id without a request", async () => {
  const server = await startServer();
  try {
    await withEnv({ [SPECS_TOKEN_ENV]: "secret-token" }, async () => {
      const tools = buildTools(server.base, ["task:read"]);
      await assertRejects(
        () => call(tools, "read_task", { task_id: "abc" }),
        Error,
        "is not a valid",
      );
      assertEquals(server.requests.length, 0);
    });
  } finally {
    await server.shutdown();
  }
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

Deno.test("specs tools surface the API error message for a 404", async () => {
  const server = await startServer();
  try {
    await withEnv({ [SPECS_TOKEN_ENV]: "secret-token" }, async () => {
      const tools = buildTools(server.base, ["spec:read"]);
      await assertRejects(
        () => call(tools, "read_spec", { spec_id: MISSING_SPEC }),
        Error,
        "Spec not found",
      );
    });
  } finally {
    await server.shutdown();
  }
});

Deno.test("specs tools surface the API error message when the body has one", async () => {
  const server = await startServer();
  try {
    await withEnv({ [SPECS_TOKEN_ENV]: "secret-token" }, async () => {
      const tools = buildTools(server.base, ["spec:read"]);
      // "boom" returns a 500 with an `error` body; the body message wins.
      await assertRejects(
        () => call(tools, "read_spec", { spec_id: BOOM_SPEC }),
        Error,
        "kaboom",
      );
    });
  } finally {
    await server.shutdown();
  }
});

Deno.test("specs tools fall back to a stable label when the error body has none", async () => {
  const server = await startServer();
  try {
    await withEnv({ [SPECS_TOKEN_ENV]: "secret-token" }, async () => {
      const tools = buildTools(server.base, ["spec:read", "spec:update"]);
      // "unauth"/"forbidden" return bodies without an `error` field, so the
      // per-status label is used.
      await assertRejects(
        () => call(tools, "read_spec", { spec_id: UNAUTH_SPEC }),
        Error,
        "Authentication failed",
      );
      await assertRejects(
        () => call(tools, "update_spec", { spec_id: FORBIDDEN_SPEC, title: "x" }),
        Error,
        "Permission denied",
      );
    });
  } finally {
    await server.shutdown();
  }
});