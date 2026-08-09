# Runner Contract: Specs Tool

This document specifies the `@huuma/cli` runner-side implementation of the
`specs` tool kind. It is self-contained: an agent can implement against this
spec without reading the Studio codebase.

Reference ADR: `docs/adr/0011-specs-tool-per-turn-jwt-access.md`

## 1. Overview

The `specs` tool gives an Agent live access to the Specs and Tasks in its
Project. The runner exposes six tool functions to the model. Each function
makes an HTTP call to the Studio's internal API. Authentication is handled by
a host-scoped sandbox secret — the runner never sees the real credential.

## 2. CLI Arguments

When the `specs` tool is enabled (i.e., `specs` is in the `--tools` list), the
runner receives two additional CLI args:

```
--specs-permissions spec:list,spec:read,spec:update,task:list,task:read,task:update
--specs-api-url https://studio.huuma.app/api/internal
```

- `--specs-permissions`: comma-separated list of permission strings. The runner
  exposes only the tool functions whose corresponding permission is present.
- `--specs-api-url`: the base URL for the Studio internal API. The runner
  appends paths to this base (e.g., `${specsApiUrl}/specs`).

If `specs` is not in `--tools`, neither arg is present.

## 3. Sandbox Secret

The Studio declares a host-scoped sandbox secret:

- **Env var name**: `HUUMA_SPECS_API_TOKEN`
- **Hosts**: `[<studio host>]` (derived from `RUN_TURN_CALLBACK_URL`)
- **Value**: a compact HS256 JWT (the real credential)

The runner sees an opaque placeholder string in the `HUUMA_SPECS_API_TOKEN`
environment variable. The sandbox egress layer substitutes the real JWT into
HTTP requests to the Studio host only. The runner must use this placeholder in
the `Authorization` header of every API call:

```http
Authorization: Bearer <placeholder>
```

The placeholder format is implementation-defined by `@deno/sandbox` and is not
the real JWT. The runner should pass it verbatim — do not attempt to decode or
parse it.

## 4. Permission Model

Six permissions control which tool functions are exposed:

| Permission     | Tool function  | HTTP call                              |
|----------------|----------------|---------------------------------------|
| `spec:list`    | `list_specs`   | `GET /specs`                          |
| `spec:read`    | `read_spec`    | `GET /specs/:specId`                  |
| `spec:update`  | `update_spec`  | `PATCH /specs/:specId`                |
| `task:list`    | `list_tasks`   | `GET /specs/:specId/tasks`            |
| `task:read`    | `read_task`    | `GET /tasks/:taskId`                  |
| `task:update`  | `update_task`  | `PATCH /tasks/:taskId`               |

The runner exposes only the functions whose permission appears in
`--specs-permissions`. The Studio API also enforces permissions server-side
as a second line of defense (returns 403 if the permission is missing from the
JWT), so even if the runner mistakenly exposes a function, the API call will
fail.

## 5. Tool Function Specifications

Each function is exposed to the model as a tool call with a JSON schema for
its parameters. The runner should define the tool using the same convention as
existing tools (e.g., `read_file`, `grep`, `search`).

### 5.1 list_specs

**Permission**: `spec:list`

**Parameters**: none

**HTTP**: `GET ${specsApiUrl}/specs`

**Response 200** — JSON array of spec summaries:

```json
[
  {
    "id": "uuid",
    "number": 1,
    "title": "Add dark mode",
    "type": "feature",
    "status": "open"
  }
]
```

**Fields**:
- `id` (string, UUID) — spec identifier
- `number` (integer) — human-friendly sequential number
- `title` (string) — spec title
- `type` (string) — one of `"feature"`, `"bug"`, `"story"`
- `status` (string) — one of `"draft"`, `"open"`, `"in_progress"`, `"done"`

**Return to model**: the JSON array as-is, or a formatted text summary.

### 5.2 read_spec

**Permission**: `spec:read`

**Parameters**:
- `spec_id` (string, required) — the spec UUID

**HTTP**: `GET ${specsApiUrl}/specs/${spec_id}`

**Response 200** — JSON object:

```json
{
  "id": "uuid",
  "number": 1,
  "title": "Add dark mode",
  "description_markdown": "## Overview\n\nImplement a dark mode toggle...",
  "type": "feature",
  "status": "open",
  "tasks": [
    {
      "id": "uuid",
      "number": 1,
      "title": "Create toggle component",
      "description_markdown": "Build a theme switcher...",
      "acceptance_criteria": ["Toggle persists across reloads"],
      "priority": "high",
      "status": "open",
      "spec_id": "uuid"
    }
  ]
}
```

**Fields**:
- `description_markdown` (string) — spec description rendered as Markdown
- `tasks` (array) — all tasks belonging to this spec, each with:
  - `description_markdown` (string) — task description as Markdown
  - `acceptance_criteria` (array of strings)
  - `priority` (string) — one of `"low"`, `"medium"`, `"high"`
  - `status` (string) — one of `"open"`, `"in_progress"`, `"done"`
  - `spec_id` (string, UUID)

### 5.3 update_spec

**Permission**: `spec:update`

**Parameters** (all optional, at least one required):
- `title` (string) — new title
- `description_markdown` (string) — new description in Markdown
- `type` (string) — one of `"feature"`, `"bug"`, `"story"`
- `status` (string) — one of `"draft"`, `"open"`, `"in_progress"`, `"done"`

**HTTP**: `PATCH ${specsApiUrl}/specs/${spec_id}`

**Request body**: JSON object with any subset of the optional fields above.

```json
{
  "status": "in_progress",
  "description_markdown": "## Updated\n\nNow with more detail."
}
```

**Response 200**: same shape as `read_spec` (the updated spec with all tasks).

### 5.4 list_tasks

**Permission**: `task:list`

**Parameters**:
- `spec_id` (string, required) — the spec UUID

**HTTP**: `GET ${specsApiUrl}/specs/${spec_id}/tasks`

**Response 200** — JSON array of tasks (same shape as `tasks` in `read_spec`):

```json
[
  {
    "id": "uuid",
    "number": 1,
    "title": "Create toggle component",
    "description_markdown": "Build a theme switcher...",
    "acceptance_criteria": ["Toggle persists across reloads"],
    "priority": "high",
    "status": "open",
    "spec_id": "uuid"
  }
]
```

### 5.5 read_task

**Permission**: `task:read`

**Parameters**:
- `task_id` (string, required) — the task UUID

**HTTP**: `GET ${specsApiUrl}/tasks/${task_id}`

**Response 200** — JSON object (single task, same shape as items in `list_tasks`).

### 5.6 update_task

**Permission**: `task:update`

**Parameters** (all optional, at least one required):
- `title` (string) — new title
- `description_markdown` (string) — new description in Markdown
- `acceptance_criteria` (array of strings) — replaces the full list
- `priority` (string) — one of `"low"`, `"medium"`, `"high"`
- `status` (string) — one of `"open"`, `"in_progress"`, `"done"`

**HTTP**: `PATCH ${specsApiUrl}/tasks/${task_id}`

**Request body**: JSON object with any subset of the optional fields above.

```json
{
  "status": "done",
  "priority": "low"
}
```

**Response 200**: the updated task (same shape as `read_task`).

## 6. Error Handling

The API returns standard HTTP status codes:

| Status | Meaning                        | Runner behavior                          |
|--------|-------------------------------|------------------------------------------|
| 200    | Success                       | Parse JSON, return to model              |
| 401    | Missing/invalid/expired token | Return error: "Authentication failed"   |
| 403    | Permission not granted        | Return error: "Permission denied"       |
| 404    | Spec/task not found           | Return error: "Not found"                |
| 5xx    | Server error                  | Return error: "Server error"             |

The runner should surface the error message from the JSON response body
(`{ "error": "..." }`) to the model so it can decide whether to retry.

If the `HUUMA_SPECS_API_TOKEN` env var is not present, the runner should not
expose any specs tool functions (treat as if `--specs-permissions` was empty).

## 7. Implementation Notes

- The runner should follow the same pattern as existing tool kinds (`search`,
  `cli`, `files`). Register the tool functions when `specs` is in `--tools` and
  `--specs-permissions` is non-empty.
- Each tool function makes a `fetch()` call to the Studio API with the
  `Authorization` header set to `Bearer [REDACTED]` env var
  value) and `Content-Type: application/json` for PATCH requests.
- The API base URL (`--specs-api-url`) does NOT end with a trailing slash.
  Paths are appended directly: `${baseUrl}/specs`, `${baseUrl}/specs/${id}`,
  etc.
- For PATCH requests, send the JSON body as the request body. Only include
  fields the model specified — do not send null or undefined fields.
- Descriptions in responses are Markdown strings. Descriptions in update
  requests are also Markdown strings. The Studio handles TipTap conversion
  internally — the runner does not need to know about TipTap.

## 8. Tool Description for the Model

The runner should provide a clear tool description so the model understands
what each function does. Suggested descriptions:

- `list_specs`: "List all Specs in the current Project. Returns an array of
  spec summaries with id, number, title, type, and status."
- `read_spec`: "Read a single Spec and all its Tasks. Returns the spec's full
  details including description (Markdown), type, status, and all tasks with
  their acceptance criteria, priority, and status."
- `update_spec`: "Update a Spec's title, description (Markdown), type, or
  status. At least one field must be provided. Returns the updated spec with
  all tasks."
- `list_tasks`: "List all Tasks belonging to a Spec. Returns an array of task
  objects with id, number, title, description (Markdown), acceptance criteria,
  priority, status, and spec_id."
- `read_task`: "Read a single Task. Returns the task's full details including
  description (Markdown), acceptance criteria, priority, and status."
- `update_task`: "Update a Task's title, description (Markdown), acceptance
  criteria, priority, or status. At least one field must be provided. Returns
  the updated task."

## 9. Acceptance Criteria

1. Runner recognizes `specs` in `--tools` and parses `--specs-permissions`
   and `--specs-api-url`.
2. Six tool functions are registered when their corresponding permission is
   present in `--specs-permissions`.
3. Each function makes an authenticated HTTP call to the Studio API using the
   `HUUMA_SPECS_API_TOKEN` env var in the `Authorization` header.
4. Only functions with a matching permission are exposed to the model.
5. PATCH request bodies contain only the fields the model specified.
6. Error responses (401, 403, 404, 5xx) are surfaced to the model with the
   error message from the response body.
7. If `HUUMA_SPECS_API_TOKEN` is not set, no specs tool functions are
   registered.
8. End-to-end: agent can list specs, read a spec, update a task status, and
   the changes are persisted.