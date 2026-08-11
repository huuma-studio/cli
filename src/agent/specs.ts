import { type Tool, tool } from "@huuma/ai/tools";
import { array, enums, object, string, uuid } from "@huuma/validate";
import { envValue } from "./env.ts";
import type { AgentTools } from "./tools.ts";

/** The eight permissions the `specs` tool kind can expose. Each maps to one
 * tool function the model may call. The Studio grants a subset per Turn and
 * passes it on the `--specs-permissions` flag; the runner exposes only those
 * functions (the Studio API re-checks each one server-side). See
 * `docs/specs/agent-specs-tool/RUNNER-CONTRACT.md`. */
export type SpecsPermission =
  | "spec:list"
  | "spec:read"
  | "spec:update"
  | "spec:create"
  | "task:list"
  | "task:read"
  | "task:update"
  | "task:create";

/** The full set, for validation of the `--specs-permissions` flag. An unknown
 * entry is a configuration error rather than a silently-ignored one, so a
 * typo fails loud — matching the `cli`/`search` fail-early convention. */
export const SPECS_PERMISSIONS: readonly SpecsPermission[] = [
  "spec:list",
  "spec:read",
  "spec:update",
  "spec:create",
  "task:list",
  "task:read",
  "task:update",
  "task:create",
];

const SPECS_PERMISSION_SET = new Set<string>(SPECS_PERMISSIONS);

/** The closed value sets the contract defines for the update fields
 * (RUNNER-CONTRACT §5). Validating them locally rejects unsupported values
 * before they reach the API. Note spec and task `status` differ: a spec may
 * be `draft`, a task may not. */
export const SPEC_TYPES = ["feature", "bug", "story"] as const;
export const SPEC_STATUSES = ["draft", "open", "in_progress", "done"] as const;
export const TASK_PRIORITIES = ["low", "medium", "high"] as const;
export const TASK_STATUSES = ["open", "in_progress", "done"] as const;

/** Sandbox env var the Studio declares as a host-scoped secret. Its value is
 * an opaque placeholder the sandbox egress layer substitutes with the real
 * per-Turn JWT for requests to the Studio host only. The runner passes it
 * verbatim in the `Authorization` header — it must never decode or log it. */
export const SPECS_TOKEN_ENV = "HUUMA_SPECS_API_TOKEN";

/** Per-run configuration the `specs` tool needs, from the agent's flags
 * (`--specs-permissions`, `--specs-api-url`). Flags, never env vars, so a
 * tooled agent cannot rewrite them for future runs (ADR 0008). The token is
 * the one env var — it is a runtime secret, not configuration. */
export interface SpecsToolOptions {
  /** Comma-separated permission strings parsed from `--specs-permissions`.
   * The runner exposes only the tool functions whose permission is present
   * here. */
  specsPermissions?: string[];
  /** Base URL of the Studio internal API, from `--specs-api-url`. Does NOT
   * end with a trailing slash; paths are appended directly. */
  specsApiUrl?: string;
}

/** Builds the `specs` tool set: the six Specs/Tasks functions the model can
 * call, restricted to the permissions granted on `--specs-permissions`.
 *
 * Registration order (RUNNER-CONTRACT, "Sandbox secret" and "Error Handling"):
 * 1. No granted permissions → register nothing (the Studio granted none).
 * 2. `$HUUMA_SPECS_API_TOKEN` unset → register nothing. The contract says to
 *    treat this exactly as if `--specs-permissions` was empty, so it short-
 *    circuits BEFORE any validation: a tokenless run never errors on a typo
 *    or a missing URL, it simply exposes nothing.
 * 3. With a token, unknown permissions or a missing `--specs-api-url` fail
 *    fast with a clear hint, mirroring `cli`/`search` (a dead or
 *    misconfigured tool is worse than an error).
 *
 * Each function makes an authenticated HTTP call to the Studio internal API
 * using the placeholder token in the `Authorization` header and surfaces API
 * errors (401/403/404/5xx) to the model. */
export function specsTools(options: SpecsToolOptions = {}): AgentTools {
  const permissions = options.specsPermissions ?? [];

  // No granted permissions means nothing to expose. Lenient, not an error: an
  // empty `--specs-permissions` is valid (the Studio simply granted none).
  if (permissions.length === 0) return [];

  // The token is a runtime secret, not a flag. Without it the runner cannot
  // authenticate any call, so it registers no functions (RUNNER-CONTRACT,
  // acceptance criterion 7 — "treat as if --specs-permissions was empty").
  // This short-circuits before validation so a tokenless run never throws on a
  // permission typo or a missing URL; it simply exposes nothing.
  const token = envValue(SPECS_TOKEN_ENV);
  if (!token) return [];

  // With a token present, unknown permissions are a configuration error, not
  // a silent skip — a typo in the Studio's flag would otherwise quietly drop
  // a function. (Unreachable when the token is unset, per the check above.)
  for (const permission of permissions) {
    if (!SPECS_PERMISSION_SET.has(permission)) {
      throw new Error(
        `Unknown specs permission "${permission}". Use --specs-permissions ` +
          `with a comma-separated list of: ${SPECS_PERMISSIONS.join(", ")}.`,
      );
    }
  }

  const apiUrl = options.specsApiUrl;
  if (!apiUrl) {
    throw new Error(
      "The specs tool needs --specs-api-url. Pass the Studio internal API " +
        "base URL, e.g. --specs-api-url https://studio.huuma.app/api/internal.",
    );
  }

  const base = apiUrl.replace(/\/+$/, "");
  const granted = new Set(permissions);
  const tools: AgentTools = [];

  if (granted.has("spec:list")) {
    tools.push(listSpecsTool(base, token));
  }
  if (granted.has("spec:read")) {
    tools.push(readSpecTool(base, token));
  }
  if (granted.has("spec:update")) {
    tools.push(updateSpecTool(base, token));
  }
  if (granted.has("spec:create")) {
    tools.push(createSpecTool(base, token));
  }
  if (granted.has("task:list")) {
    tools.push(listTasksTool(base, token));
  }
  if (granted.has("task:read")) {
    tools.push(readTaskTool(base, token));
  }
  if (granted.has("task:update")) {
    tools.push(updateTaskTool(base, token));
  }
  if (granted.has("task:create")) {
    tools.push(createTaskTool(base, token));
  }
  return tools;
}

/** `list_specs` — all Specs in the current Project (summaries). */
function listSpecsTool(base: string, token: string): Tool<ReturnType<typeof emptyObject>, unknown> {
  return tool({
    name: "list_specs",
    description:
      "List all Specs in the current Project. Returns an array of spec " +
      "summaries with id, number, title, type, and status.",
    input: object({}),
    fn: () => specsRequest("GET", `${base}/specs`, token),
  });
}

/** `read_spec` — one Spec and all its Tasks. */
function readSpecTool(base: string, token: string): Tool<ReturnType<typeof specIdInput>, unknown> {
  return tool({
    name: "read_spec",
    description:
      "Read a single Spec and all its Tasks. Returns the spec's full details " +
      "including description (Markdown), type, status, and all tasks with " +
      "their acceptance criteria, priority, and status.",
    input: specIdInput(),
    fn: ({ spec_id }) => specsRequest("GET", `${base}/specs/${spec_id}`, token),
  });
}

/** `update_spec` — update a Spec's title, description, type, or status. */
function updateSpecTool(base: string, token: string): Tool<ReturnType<typeof updateSpecInput>, unknown> {
  return tool({
    name: "update_spec",
    description:
      "Update a Spec's title, description (Markdown), type, or status. At " +
      "least one field must be provided. Returns the updated spec with all " +
      "tasks.",
    input: updateSpecInput(),
    fn: (fields) => {
      const body = pickDefined(fields, [
        "title",
        "description_markdown",
        "type",
        "status",
      ]);
      requireAtLeastOne(body, "update_spec");
      return specsRequest("PATCH", `${base}/specs/${fields.spec_id}`, token, body);
    },
  });
}

/** `create_spec` — create a new Spec in the current Project. */
function createSpecTool(base: string, token: string): Tool<ReturnType<typeof createSpecInput>, unknown> {
  return tool({
    name: "create_spec",
    description:
      "Create a new Spec in the current Project. Requires a title, " +
      "description (Markdown), type, and status. Returns the created spec " +
      "with its tasks (initially empty).",
    input: createSpecInput(),
    fn: (fields) => {
      const body = pickDefined(fields, [
        "title",
        "description_markdown",
        "type",
        "status",
      ]);
      return specsRequest("POST", `${base}/specs`, token, body);
    },
  });
}

/** `list_tasks` — all Tasks belonging to one Spec. */
function listTasksTool(base: string, token: string): Tool<ReturnType<typeof specIdInput>, unknown> {
  return tool({
    name: "list_tasks",
    description:
      "List all Tasks belonging to a Spec. Returns an array of task objects " +
      "with id, number, title, description (Markdown), acceptance criteria, " +
      "priority, status, and spec_id.",
    input: specIdInput(),
    fn: ({ spec_id }) =>
      specsRequest("GET", `${base}/specs/${spec_id}/tasks`, token),
  });
}

/** `read_task` — one Task with full detail. */
function readTaskTool(base: string, token: string): Tool<ReturnType<typeof taskIdInput>, unknown> {
  return tool({
    name: "read_task",
    description:
      "Read a single Task. Returns the task's full details including " +
      "description (Markdown), acceptance criteria, priority, and status.",
    input: taskIdInput(),
    fn: ({ task_id }) => specsRequest("GET", `${base}/tasks/${task_id}`, token),
  });
}

/** `update_task` — update a Task's title, description, acceptance criteria,
 * priority, or status. */
function updateTaskTool(base: string, token: string): Tool<ReturnType<typeof updateTaskInput>, unknown> {
  return tool({
    name: "update_task",
    description:
      "Update a Task's title, description (Markdown), acceptance criteria, " +
      "priority, or status. At least one field must be provided. Returns the " +
      "updated task.",
    input: updateTaskInput(),
    fn: (fields) => {
      const body = pickDefined(fields, [
        "title",
        "description_markdown",
        "acceptance_criteria",
        "priority",
        "status",
      ]);
      requireAtLeastOne(body, "update_task");
      return specsRequest("PATCH", `${base}/tasks/${fields.task_id}`, token, body);
    },
  });
}

/** `create_task` — create a new Task belonging to a Spec. */
function createTaskTool(base: string, token: string): Tool<ReturnType<typeof createTaskInput>, unknown> {
  return tool({
    name: "create_task",
    description:
      "Create a new Task belonging to a Spec. Requires a spec_id, title, " +
      "description (Markdown), priority, and status. Acceptance criteria are " +
      "optional. Returns the created task.",
    input: createTaskInput(),
    fn: (fields) => {
      const body = pickDefined(fields, [
        "title",
        "description_markdown",
        "acceptance_criteria",
        "priority",
        "status",
      ]);
      return specsRequest(
        "POST",
        `${base}/specs/${fields.spec_id}/tasks`,
        token,
        body,
      );
    },
  });
}

// --- input schemas --------------------------------------------------------

/** Empty object — `list_specs` takes no parameters. */
function emptyObject() {
  return object({});
}

/** `{ spec_id: uuid }` — shared by `read_spec`, `update_spec`, `list_tasks`.
 * The UUID constraint rejects malformed identifiers before they reach the API
 * and, critically, blocks path separators (`/`) that would otherwise alter
 * the declared request path (e.g. `specs/<id>/tasks`). */
function specIdInput() {
  return object({ spec_id: uuid() });
}

/** `{ task_id: uuid }` — shared by `read_task`, `update_task`. */
function taskIdInput() {
  return object({ task_id: uuid() });
}

/** `update_spec` parameters: all optional, at least one required. The
 * "at-least-one" rule is enforced in the function body, not the schema
 * (the validator cannot express cross-field requirements). `type` and
 * `status` are constrained to the contract's closed value sets. */
function updateSpecInput() {
  return object({
    spec_id: uuid(),
    title: string().optional(),
    description_markdown: string().optional(),
    type: enums([...SPEC_TYPES]).optional(),
    status: enums([...SPEC_STATUSES]).optional(),
  });
}

/** `update_task` parameters: all optional, at least one required. `priority`
 * and `status` are constrained to the contract's closed value sets. */
function updateTaskInput() {
  return object({
    task_id: uuid(),
    title: string().optional(),
    description_markdown: string().optional(),
    acceptance_criteria: array(string()).optional(),
    priority: enums([...TASK_PRIORITIES]).optional(),
    status: enums([...TASK_STATUSES]).optional(),
  });
}

/** `create_spec` parameters: all required. `type` and `status` are
 * constrained to the contract's closed value sets. The `project_id` is
 * injected server-side from the JWT claims, so the model does not provide
 * it. */
function createSpecInput() {
  return object({
    title: string(),
    description_markdown: string(),
    type: enums([...SPEC_TYPES]),
    status: enums([...SPEC_STATUSES]),
  });
}

/** `create_task` parameters: `spec_id` identifies the parent Spec (in the
 * request path); the rest are the task's fields. `acceptance_criteria` is
 * optional; `priority` and `status` are constrained to the contract's closed
 * value sets. The `project_id` is injected server-side from the JWT claims. */
function createTaskInput() {
  return object({
    spec_id: uuid(),
    title: string(),
    description_markdown: string(),
    acceptance_criteria: array(string()).optional(),
    priority: enums([...TASK_PRIORITIES]),
    status: enums([...TASK_STATUSES]),
  });
}

// --- HTTP ------------------------------------------------------------------

/** Methods that send a JSON body. */
const BODY_METHODS = new Set(["PATCH", "POST", "PUT"]);

/** Makes one authenticated request to the Studio internal API and returns the
 * parsed JSON body on success. On a non-2xx response it throws an Error whose
 * message is the API's `{ error }` body when present, otherwise a status-based
 * summary — so the model can decide whether to retry (RUNNER-CONTRACT,
 * "Error Handling"). The token placeholder is passed verbatim; it is never
 * logged. */
async function specsRequest(
  method: string,
  url: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  const init: RequestInit = { method, headers };
  if (BODY_METHODS.has(method) && body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  return await handleResponse(response);
}

/** Parses a success body as JSON or throws a descriptive error for a failure
 * status. Prefers the API's `{ error }` message; falls back to a stable
 * per-status label so a missing or non-JSON error body still reads clearly. */
async function handleResponse(response: Response): Promise<unknown> {
  if (response.ok) {
    return await response.json();
  }
  const apiError = await readErrorBody(response);
  const message = apiError ?? errorLabel(response.status);
  throw new Error(message);
}

/** Reads the `error` string from a JSON error body when the API provides one.
 * Never throws — a malformed or non-JSON body simply yields `undefined`. */
async function readErrorBody(response: Response): Promise<string | undefined> {
  try {
    const body = await response.json();
    if (body !== null && typeof body === "object" && "error" in body) {
      const value = (body as { error?: unknown }).error;
      if (typeof value === "string" && value.length > 0) return value;
    }
  } catch {
    // Non-JSON body or no body — fall through to the status label.
  }
  return undefined;
}

/** Maps the contract's error statuses to stable labels. 5xx and any other
 * unexpected status get a generic "Server error" / "Request failed" message so
 * the model sees something actionable without a leaky status code. */
function errorLabel(status: number): string {
  if (status === 401) return "Authentication failed";
  if (status === 403) return "Permission denied";
  if (status === 404) return "Not found";
  if (status >= 500) return "Server error";
  return `Request failed (status ${status})`;
}

// --- helpers ---------------------------------------------------------------

/** Returns a shallow copy of `fields` containing only the listed keys whose
 * values are not `undefined`, so PATCH bodies never send null/undefined
 * fields the model did not specify (RUNNER-CONTRACT, "Implementation Notes"). */
function pickDefined(
  fields: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of keys) {
    if (fields[key] !== undefined) body[key] = fields[key];
  }
  return body;
}

/** Throws when no update field was provided — the contract requires at least
 * one. The schema cannot express this cross-field rule, so it is enforced
 * here. */
function requireAtLeastOne(
  body: Record<string, unknown>,
  toolName: string,
): void {
  if (Object.keys(body).length === 0) {
    throw new Error(
      `${toolName} requires at least one field to update ` +
        "(title, description_markdown, type/status, priority, or " +
        "acceptance_criteria as applicable).",
    );
  }
}