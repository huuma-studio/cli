# Runner Contract: Specs Tool

This document specifies the `@huuma/cli` runner-side implementation of the
`specs` tool kind. It is self-contained: an agent can implement against this
spec without reading the Studio codebase.

Reference ADR: `docs/adr/0011-specs-tool-per-turn-jwt-access.md`

## 1. Overview

The `specs` tool gives an Agent live access to the Specs and Tasks in its
Project, and lets the calling Run associate itself with a Spec. The runner
exposes eleven tool functions to the model. Each function makes an HTTP call
to the Studio's internal API. Authentication is handled by a host-scoped
sandbox secret — the runner never sees the real credential.

## 2. CLI Arguments

When the `specs` tool is enabled (i.e., `specs` is in the `--tools` list), the
runner receives two additional CLI args:

```
--specs-permissions spec:list,spec:read,spec:update,spec:create,spec:associate,task:list,task:read,task:update,task:create
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

Nine permissions control which tool functions are exposed:

| Permission        | Tool function                        | HTTP call                                  |
|-------------------|--------------------------------------|--------------------------------------------|
| `spec:list`       | `list_specs`                         | `GET /specs`                               |
| `spec:read`       | `read_spec`, `list_spec_runs`        | `GET /specs/:specId`, `GET /specs/:specId/runs` |
| `spec:update`     | `update_spec`                        | `PATCH /specs/:specId`                     |
| `spec:create`     | `create_spec`                        | `POST /specs`                              |
| `spec:associate`  | `associate_spec`, `disassociate_spec`| `POST /specs/:specId/runs`, `DELETE /specs/:specId/runs` |
| `task:list`       | `list_tasks`                         | `GET /specs/:specId/tasks`                 |
| `task:read`       | `read_task`                          | `GET /tasks/:taskId`                       |
| `task:update`     | `update_task`                        | `PATCH /tasks/:taskId`                     |
| `task:create`     | `create_task`                        | `POST /specs/:specId/tasks`                |

The runner exposes only the functions whose permission appears in
`--specs-permissions`. The Studio API also enforces permissions server-side
as a second line of defense (returns 403 if the permission is missing from the
JWT), so even if the runner mistakenly exposes a function, the API call will
fail.

### 4.1 Association security property

The association target Run is always identified by the JWT `run_id` claim —
the identity the Studio minted for the calling Run. The model never supplies a
run identifier: no association tool input schema contains one, and any run id
in a request body is ignored by the API. A Run can therefore only associate
itself, never another Run.

### 4.2 Registration order

Tool registration order is deterministic and follows the permission checks:
`list_specs`, `read_spec`, `list_spec_runs`, `update_spec`, `create_spec`,
`associate_spec`, `disassociate_spec`, `list_tasks`, `read_task`,
`update_task`, `create_task`. The relative order of the original eight
functions is unchanged; `list_spec_runs` is registered with its
`spec:read` sibling and the association pair with `spec:associate`.

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

### 5.4 create_spec

**Permission**: `spec:create`

**Parameters** (all required):
- `title` (string) — spec title
- `description_markdown` (string) — spec description in Markdown
- `type` (string) — one of `"feature"`, `"bug"`, `"story"`
- `status` (string) — one of `"draft"`, `"open"`, `"in_progress"`, `"done"`

**HTTP**: `POST ${specsApiUrl}/specs`

**Request body**: JSON object with all four fields above.

```json
{
  "title": "Add dark mode",
  "description_markdown": "## Overview\n\nImplement a dark mode toggle.",
  "type": "feature",
  "status": "draft"
}
```

**Response 200**: same shape as `read_spec` (the created spec with an empty
`tasks` array). The `project_id` is injected server-side from the JWT claims;
the model does not provide it.

### 5.5 list_tasks

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

### 5.6 read_task

**Permission**: `task:read`

**Parameters**:
- `task_id` (string, required) — the task UUID

**HTTP**: `GET ${specsApiUrl}/tasks/${task_id}`

**Response 200** — JSON object (single task, same shape as items in `list_tasks`).

### 5.7 update_task

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

### 5.8 create_task

**Permission**: `task:create`

**Parameters**:
- `spec_id` (string, required) — the parent spec UUID
- `title` (string, required) — task title
- `description_markdown` (string, required) — task description in Markdown
- `acceptance_criteria` (array of strings, optional) — defaults to empty
- `priority` (string, required) — one of `"low"`, `"medium"`, `"high"`
- `status` (string, required) — one of `"open"`, `"in_progress"`, `"done"`

**HTTP**: `POST ${specsApiUrl}/specs/${spec_id}/tasks`

**Request body**: JSON object with the fields above (excluding `spec_id`, which
is in the URL path).

```json
{
  "title": "Create toggle component",
  "description_markdown": "Build a theme switcher.",
  "priority": "high",
  "status": "open",
  "acceptance_criteria": ["Toggle persists across reloads"]
}
```

**Response 200**: the created task (same shape as `read_task`). The
`project_id` is injected server-side from the JWT claims; the model does not
provide it.

### 5.9 list_spec_runs

**Permission**: `spec:read`

**Parameters**:
- `spec_id` (string, required) — the spec UUID

**HTTP**: `GET ${specsApiUrl}/specs/${spec_id}/runs`

**Response 200** — JSON array of associated Run summaries, newest first:

```json
[
  {
    "id": "uuid",
    "status": "in_progress",
    "created_at": "2026-09-01T12:00:00.000Z"
  }
]
```

**Fields**:
- `id` (string, UUID) — run identifier
- `status` (string) — the Run's lifecycle status
- `created_at` (string) — association creation timestamp

**Return to model**: the JSON array as-is (empty when the Spec has no
associated Runs).

### 5.10 associate_spec

**Permission**: `spec:associate`

**Parameters**:
- `spec_id` (string, required) — the spec UUID

**HTTP**: `POST ${specsApiUrl}/specs/${spec_id}/runs`

**Request body**: the empty JSON object `{}` (with `Content-Type:
application/json`). The association target Run is identified by the JWT
`run_id` claim (§4.1); the model does not provide a run identifier.

**Response 200** — the association row (existing pair returns the existing
association — idempotent, never an error):

```json
{
  "spec_id": "uuid",
  "run_id": "uuid",
  "created_at": "2026-09-01T12:00:00.000Z"
}
```

### 5.11 disassociate_spec

**Permission**: `spec:associate`

**Parameters**:
- `spec_id` (string, required) — the spec UUID

**HTTP**: `DELETE ${specsApiUrl}/specs/${spec_id}/runs`

**Request body**: none.

**Response 200** — a small JSON status:

```json
{
  "removed": true
}
```

**Idempotency**: removing an absent association is a no-op success returning
`{ "removed": false }`; removing an existing one returns
`{ "removed": true }`. Both are success responses, never errors.

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
  `associate_spec` sends the empty JSON object `{}` as its POST body (§5.10);
  `disassociate_spec` sends no body.
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
- `create_spec`: "Create a new Spec in the current Project. Requires a title,
  description (Markdown), type, and status. Returns the created spec with its
  tasks (initially empty)."
- `list_tasks`: "List all Tasks belonging to a Spec. Returns an array of task
  objects with id, number, title, description (Markdown), acceptance criteria,
  priority, status, and spec_id."
- `read_task`: "Read a single Task. Returns the task's full details including
  description (Markdown), acceptance criteria, priority, and status."
- `update_task`: "Update a Task's title, description (Markdown), acceptance
  criteria, priority, or status. At least one field must be provided. Returns
  the updated task."
- `create_task`: "Create a new Task belonging to a Spec. Requires a spec_id,
  title, description (Markdown), priority, and status. Acceptance criteria are
  optional. Returns the created task."
- `list_spec_runs`: "List the Runs associated with a Spec. Returns an array of
  run summaries with id, status, and association created_at, newest first."
- `associate_spec`: "Associate the current Run with a Spec. The Run is
  identified by the runner's own credentials — no run id is passed.
  Idempotent: associating an already-associated pair returns the existing
  association with spec_id, run_id, and created_at."
- `disassociate_spec`: "Remove the current Run's association with a Spec.
  Idempotent: removing an absent association is a no-op that returns
  { removed: false }; removing an existing one returns { removed: true }."

## 9. Acceptance Criteria

1. Runner recognizes `specs` in `--tools` and parses `--specs-permissions`
   and `--specs-api-url`.
2. Eleven tool functions are registered when their corresponding permission is
   present in `--specs-permissions`, in the documented order (§4.2).
3. Each function makes an authenticated HTTP call to the Studio API using the
   `HUUMA_SPECS_API_TOKEN` env var in the `Authorization` header.
4. Only functions with a matching permission are exposed to the model.
5. PATCH and POST request bodies contain only the fields the model specified;
   `associate_spec` always sends the empty JSON object `{}`.
6. Error responses (401, 403, 404, 5xx) are surfaced to the model with the
   error message from the response body.
7. If `HUUMA_SPECS_API_TOKEN` is not set, no specs tool functions are
   registered.
8. End-to-end: agent can list specs, read a spec, update a task status, and
   the changes are persisted.
9. End-to-end: agent can create a new spec and create a task under an existing
   spec, and the changes are persisted.
10. Association: `associate_spec` and `disassociate_spec` require
    `spec:associate`, `list_spec_runs` requires `spec:read`, and each calls
    `${specsApiUrl}/specs/:specId/runs` with the documented method.
11. No tool input or request carries a run identifier; the association target
    Run comes from the JWT `run_id` claim (§4.1).
12. Idempotent association outcomes are returned to the model as success
    responses: an existing pair returns the existing association, and an
    absent disassociation returns `{ removed: false }`.