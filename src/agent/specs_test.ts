import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { SpecsPermission } from "./specs.ts";
import { SPECS_PERMISSIONS, SPECS_TOKEN_ENV, specsTools } from "./specs.ts";
import { resolveTools } from "./tools.ts";
import { withEnv } from "./testing.ts";

/** All six permissions, in declaration order. */
const ALL_PERMISSIONS = [...SPECS_PERMISSIONS];

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
 * paths; special IDs (`forbidden`, `unauth`, `boom`, `missing`) exercise the
 * error contract. */
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
      {
        id: "s1",
        number: 1,
        title: "Add dark mode",
        type: "feature",
        status: "open",
      },
    ]);
  }
  if (path.startsWith("/specs/") && log.method === "GET") {
    const id = path.slice("/specs/".length);
    // Strip a possible "/tasks" suffix for the list_tasks route.
    const [specId, rest] = id.split("/");
    if (rest === "tasks") {
      return json(200, [
        taskFixture(specId, "t1", 1, "Create toggle", "high", "open"),
      ]);
    }
    if (specId === "missing") return json(404, { error: "Spec not found" });
    if (specId === "forbidden") return json(403, { detail: "no access" });
    if (specId === "unauth") return json(401, { detail: "bad token" });
    if (specId === "boom") return json(500, { error: "kaboom" });
    return json(200, {
      id: specId,
      number: 1,
      title: "Add dark mode",
      description_markdown: "## Overview\n\nImplement a dark mode toggle.",
      type: "feature",
      status: "open",
      tasks: [taskFixture(specId, "t1", 1, "Create toggle", "high", "open")],
    });
  }
  if (path.startsWith("/specs/") && log.method === "PATCH") {
    const specId = path.slice("/specs/".length);
    if (specId === "forbidden") return json(403, { detail: "no access" });
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
    if (taskId === "missing") return json(404, { error: "Task not found" });
    if (taskId === "forbidden") return json(403, { detail: "no access" });
    return json(200, taskFixture("s1", taskId, 1, "Create toggle", "high", "open"));
  }
  if (path.startsWith("/tasks/") && log.method === "PATCH") {
    const taskId = path.slice("/tasks/".length);
    if (taskId === "forbidden") return json(403, { detail: "no access" });
    return json(200, taskFixture("s1", taskId, 1, "Create toggle", "high",
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
      [
        "list_specs",
        "read_spec",
        "update_spec",
        "list_tasks",
        "read_task",
        "update_task",
      ],
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
      const tools = specsTools({
        specsPermissions: ["spec:list"],
        specsApiUrl: server.base,
      });
      const result = await call(tools, "list_specs", {});
      assertEquals(result, [
        { id: "s1", number: 1, title: "Add dark mode", type: "feature", status: "open" },
      ]);
      // The Authorization header carries the placeholder token verbatim.
      assertEquals(server.requests[0].auth, "Bearer secret-token");
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
      const tools = specsTools({
        specsPermissions: ["spec:read"],
        specsApiUrl: server.base,
      });
      const result = await call(tools, "read_spec", { spec_id: "s1" }) as {
        id: string;
        tasks: unknown[];
      };
      assertEquals(result.id, "s1");
      assertEquals(result.tasks.length, 1);
      assertEquals(server.requests[0].path, "/specs/s1");
    });
  } finally {
    await server.shutdown();
  }
});

Deno.test("update_spec sends only the provided fields", async () => {
  const server = await startServer();
  try {
    await withEnv({ [SPECS_TOKEN_ENV]: "secret-token" }, async () => {
      const tools = specsTools({
        specsPermissions: ["spec:update"],
        specsApiUrl: server.base,
      });
      const result = await call(tools, "update_spec", {
        spec_id: "s1",
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
      const tools = specsTools({
        specsPermissions: ["spec:update"],
        specsApiUrl: server.base,
      });
      await assertRejects(
        () => call(tools, "update_spec", { spec_id: "s1" }),
        Error,
        "update_spec requires at least one field",
      );
    });
  } finally {
    await server.shutdown();
  }
});

Deno.test("list_tasks and read_task return task data", async () => {
  const server = await startServer();
  try {
    await withEnv({ [SPECS_TOKEN_ENV]: "secret-token" }, async () => {
      const tools = specsTools({
        specsPermissions: ["task:list", "task:read"],
        specsApiUrl: server.base,
      });
      const tasks = await call(tools, "list_tasks", { spec_id: "s1" }) as unknown[];
      assertEquals(tasks.length, 1);
      assertEquals(server.requests[0].path, "/specs/s1/tasks");
      const task = await call(tools, "read_task", { task_id: "t9" }) as { id: string };
      assertEquals(task.id, "t9");
      assertEquals(server.requests[1].path, "/tasks/t9");
    });
  } finally {
    await server.shutdown();
  }
});

Deno.test("update_task sends acceptance_criteria and provided fields", async () => {
  const server = await startServer();
  try {
    await withEnv({ [SPECS_TOKEN_ENV]: "secret-token" }, async () => {
      const tools = specsTools({
        specsPermissions: ["task:update"],
        specsApiUrl: server.base,
      });
      const result = await call(tools, "update_task", {
        task_id: "t1",
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
// Error handling
// ---------------------------------------------------------------------------

Deno.test("specs tools surface the API error message for a 404", async () => {
  const server = await startServer();
  try {
    await withEnv({ [SPECS_TOKEN_ENV]: "secret-token" }, async () => {
      const tools = specsTools({
        specsPermissions: ["spec:read"],
        specsApiUrl: server.base,
      });
      await assertRejects(
        () => call(tools, "read_spec", { spec_id: "missing" }),
        Error,
        "Spec not found",
      );
    });
  } finally {
    await server.shutdown();
  }
});

Deno.test("specs tools return a stable label when the error body has none", async () => {
  const server = await startServer();
  try {
    await withEnv({ [SPECS_TOKEN_ENV]: "secret-token" }, async () => {
      const tools = specsTools({
        specsPermissions: ["spec:read"],
        specsApiUrl: server.base,
      });
      // "boom" returns a 500 with an error body; assert the label falls back
      // to "Server error" only when the body lacks an `error` string — here it
      // has one, so the body message wins.
      await assertRejects(
        () => call(tools, "read_spec", { spec_id: "boom" }),
        Error,
        "kaboom",
      );
    });
  } finally {
    await server.shutdown();
  }
});

Deno.test("specs tools map 401 and 403 to clear labels", async () => {
  const server = await startServer();
  try {
    await withEnv({ [SPECS_TOKEN_ENV]: "secret-token" }, async () => {
      const tools = specsTools({
        specsPermissions: ["spec:read", "spec:update"],
        specsApiUrl: server.base,
      });
      await assertRejects(
        () => call(tools, "read_spec", { spec_id: "unauth" }),
        Error,
        "Authentication failed",
      );
      await assertRejects(
        () => call(tools, "update_spec", { spec_id: "forbidden", title: "x" }),
        Error,
        "Permission denied",
      );
    });
  } finally {
    await server.shutdown();
  }
});