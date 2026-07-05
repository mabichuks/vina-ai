# API Spec — REST and WebSocket

The contract between the React frontend and the Fastify server. All endpoints live under `/api`. All requests except `/api/bootstrap` require a `Authorization: Bearer <token>` header.

All schemas referenced here are zod schemas defined in `packages/shared/src/schemas/`.

## Conventions

- All requests and responses are JSON
- All timestamps are ISO-8601 UTC strings
- Resource ids are ULIDs as TEXT
- Errors are `{ code: string, message: string, details?: unknown }` with appropriate HTTP status

## Bootstrap

### `GET /api/bootstrap`

No auth required. Returns the bearer token and the version. The frontend calls this on first load and stores the token in memory (not localStorage, since it's per-process).

```json
{
  "version": "0.1.0",
  "token": "...",
  "onboarded": false
}
```

`onboarded` is `true` when a profile, an LLM provider, at least one CV, and at least one enabled source exist.

## Profile

### `GET /api/profile`

Returns the single profile or `404` if none.

### `POST /api/profile`

Creates the profile. Body: `ProfileInput`.

### `PATCH /api/profile`

Updates fields.

## CVs

### `GET /api/cvs`

Returns all CVs ordered by created_at desc.

### `POST /api/cvs`

Multipart upload. Fields: `file`, `label`. Returns the new CV row.

### `GET /api/cvs/:id/download`

Streams the original file.

### `DELETE /api/cvs/:id`

Errors with `409 ConflictError` if any application references it.

### `POST /api/cvs/:id/default`

Marks this CV as default; clears the flag on others.

## Cover Letters

Same shape as CVs under `/api/cover-letters`.

## Search Preferences

### `GET /api/search-preferences`

### `PUT /api/search-preferences`

Replaces the (single) preference set.

## Schedule

### `GET /api/schedules`

### `POST /api/schedules`

### `PATCH /api/schedules/:id`

### `DELETE /api/schedules/:id`

## Settings

### `GET /api/settings`

Never returns the SerpAPI key. Returns `{ ..., has_serpapi_key: boolean }`.

### `PATCH /api/settings`

Body fields all optional: `mode`, `approval`, `browser_headful`, `browser_stealth` (opt-in anti-detection masking, default `false`; ADR-021), `paused`, `active_llm_provider_id`, `serpapi_key` (when set, server validates by making a minimal call before saving).

### `DELETE /api/settings/serpapi-key`

Clears the SerpAPI key. If the `google` site is enabled, it is automatically disabled.

## LLM Providers

### `GET /api/llm-providers`

Never returns the API key. Returns `{ id, kind, label, model, base_url, has_api_key, created_at }`.

### `POST /api/llm-providers`

Body: `{ kind, label, model, base_url?, api_key? }`. Server validates by making a minimal completion call before saving. Returns the row.

### `DELETE /api/llm-providers/:id`

Errors if it's the active provider.

### `POST /api/llm-providers/:id/test`

Re-runs the validation call. Returns `{ ok: true, latency_ms }` or `{ ok: false, reason }`.

## Sites

### `GET /api/sites`

Returns: `[{ id, display_name, kind, enabled, has_session, session_valid_at, last_search_at }]`. For `kind='api'` rows (like `google`), `has_session` reflects whether the relevant API key (e.g. SerpAPI) is present and `session_valid_at` reflects the last successful API call.

### `PATCH /api/sites/:id`

Body: `{ enabled }`. Toggling on without a valid session/key is allowed but the UI should prompt to log in / configure the key. For `google`, toggling on with no SerpAPI key set returns `409 ConflictError` with `code: 'serpapi_key_required'`.

### `POST /api/sites/:id/login`

For `kind='browser'` sites only. Starts an interactive login. Server launches headful Playwright. Returns immediately with `{ status: 'pending', login_id }`. Frontend subscribes to the WebSocket event `site:login_status` for updates: `{ login_id, status: 'completed' | 'failed' | 'cancelled', reason? }`.

For `kind='api'` sites, this endpoint returns `405 Method Not Allowed` — use `PATCH /api/settings` with the relevant API key instead.

### `POST /api/sites/:id/test`

For `kind='api'` sites only. Re-runs a minimal validation call (SerpAPI for `google`). Returns `{ ok: true, latency_ms }` or `{ ok: false, reason }`.

### `DELETE /api/sites/:id/session`

For `kind='browser'` sites: logs out — deletes the storage state for the site. For `kind='api'` sites: returns `405 Method Not Allowed` — use the relevant settings endpoint to clear the API key.

## Jobs

### `GET /api/jobs`

Query params:

- `status` — comma-separated list of statuses to include
- `site_id` — filter by site (`linkedin`, `indeed`, `google`)
- `apply_method` — `auto` or `manual`
- `min_score` — integer
- `q` — full-text on title + company + description
- `limit`, `cursor` — pagination

### `GET /api/jobs/:id`

Full job detail, including `external_apply_url` and `original_source` for manual-apply jobs.

### `POST /api/jobs/:id/dismiss`

Marks the job as `dismissed`.

### `POST /api/jobs/:id/apply`

Used in supervised mode: explicit user request to apply. Server inspects `apply_method` and enqueues either an `apply` task (auto) or a `prepare_manual_apply` task (manual). Returns `{ application_id }`.

### `POST /api/jobs/search-now`

Triggers an immediate search across all enabled sources, bypassing the schedule. Returns 202.

## Searches

### `POST /api/searches/run-now`

Body: `{ site_id: string }`. Enqueues an immediate search task for the given site, bypassing the schedule. Returns `202 { task_id, deduped }`. If a pending task already exists with `attempts === 0` the existing id is returned with `deduped: true`. If the task is in retry backoff (`attempts > 0`) `next_attempt_at` is fast-forwarded to now, the worker is poked, and the response includes `retried: true`.

### `POST /api/searches/cancel`

Body: `{ task_id?: string, site_id?: string }`. At least one must be provided.

Cancels running **and** pending (retry-backoff) search tasks:

- **`task_id`**: cancels the single named task. If the task is actively running, its in-memory abort signal is fired. If it is pending in retry backoff, its `task_queue` row is flipped to `cancelled` directly (the worker will never claim it). For backoff rows a `search:cancelled` WebSocket event is emitted immediately, since no handler is executing to emit it.
- **`site_id`**: sweeps all cancellable tasks for that site — first aborts any live in-memory registrations, then flips all remaining `pending` rows for that site. A `search:cancelled` WebSocket event is emitted for each backoff row that is flipped.

`cancelled` in the response counts distinct tasks acted on (rows flipped plus signals aborted, without double-counting). A second identical call returns `{ cancelled: 0 }` — idempotent.

## Applications

### `GET /api/applications`

Query params: `status`, `site_id`, `apply_method` (in addition to existing pagination/filter).

### `GET /api/applications/:id`

Full detail including `events[]`, the resolved `cv_id`/`cover_letter_id`, and (for manual-apply) `external_apply_url`.

### `GET /api/applications/:id/tailored-cv`

Streams the tailored DOCX.

### `GET /api/applications/:id/tailored-cover-letter`

Streams the tailored cover letter (if any).

### `POST /api/applications/:id/approve`

For review-first auto-apply flow. Server transitions the status from `awaiting_approval` → `queued` and enqueues the apply task.

### `POST /api/applications/:id/reject-cv`

Body: `{ regenerate: boolean, instruction?: string }`. If `regenerate` is true, the server re-runs `tailor-cv` with the optional instruction; status stays `awaiting_approval`. If false, the application moves to `skipped`.

### `POST /api/applications/:id/cancel`

For applications in `queued`, `awaiting_user`, or `ready_for_manual_apply`. Marks `skipped` and resolves any related alerts.

### `POST /api/applications/:id/retry`

For applications in `failed`. Re-enqueues if the failure was transient.

### `POST /api/applications/:id/mark-applied`

**For manual-apply applications only.** Body: `{ applied_at?: string, notes?: string }` (both optional; `applied_at` defaults to now).

Transitions the application from `ready_for_manual_apply` → `applied_manually`, sets `applied_manually_at` and `applied_manually_notes`, and auto-resolves the related `ready_for_manual_apply` alert.

Errors with `409 ConflictError` if the application is not in `ready_for_manual_apply`.

## Alerts

### `GET /api/alerts`

Query params: `status`, `kind`. Default: open.

### `POST /api/alerts/:id/resolve`

Body depends on the alert's `kind`:

- `missing_field`: `{ value: string, save_for_future: boolean }`
- `captcha`: `{ solved: true }` (server then proceeds with submit)
- `awaiting_approval`: `{ approve: boolean, instruction?: string }`
- `session_expired`: posting this just dismisses the alert; the user must hit `/api/sites/:id/login`
- `apply_failed`: `{ retry: boolean }`
- `ready_for_manual_apply`: `{ marked_applied: true, applied_at?: string, notes?: string }` — equivalent to calling `POST /api/applications/:id/mark-applied` and is provided so the alert can be resolved inline

### `POST /api/alerts/:id/dismiss`

## Chat

### `GET /api/chat/messages`

Query: `before` (id) for cursor pagination, `limit` (default 50). Returns most recent messages first.

### `POST /api/chat/messages`

Body: `{ content: string }`. Server records the user message, kicks off the chat graph, streams assistant tokens via WebSocket (`chat:token`), and sends `chat:message` events on completion.

### `DELETE /api/chat/messages`

Wipes the chat transcript. Profile answers and other persistent context survive.

## System

### `GET /api/system/status`

```json
{
  "version": "0.1.0",
  "started_at": "2026-04-26T13:21:00Z",
  "scheduler": { "running": true, "next_run_at": "..." },
  "queue": { "pending": 3, "running": 1 },
  "active_provider": { "kind": "anthropic", "model": "claude-opus-4-7" },
  "sources": [
    { "id": "linkedin", "enabled": true, "kind": "browser", "ok": true },
    { "id": "indeed", "enabled": true, "kind": "browser", "ok": true },
    { "id": "google", "enabled": false, "kind": "api", "ok": null }
  ]
}
```

### `POST /api/system/pause`

Sets `settings.paused = 1`. The scheduler stops firing; in-flight tasks finish.

### `POST /api/system/resume`

### `POST /api/system/reset`

Wipes all data. Body: `{ confirm: 'reset' }` is required as a literal string.

### `POST /api/system/export`

Returns a streamed ZIP with the database and all files. For backup.

## WebSocket

`ws://localhost:7341/ws?token=<bearer>` — single connection per browser tab.

### Server → Client envelope

```json
{ "type": "<event_name>", "payload": { ... }, "timestamp": "..." }
```

### Event names

| Event                                | Payload                                                                                                               |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `jobs:updated`                       | `{ ids: string[] }` — frontend refetches                                                                              |
| `application:updated`                | `{ id: string, status: string }`                                                                                      |
| `application:event`                  | `{ application_id, kind, payload }` — append to timeline live                                                         |
| `application:ready_for_manual_apply` | `{ application_id, external_apply_url, tailored_cv_path }` — fired when a manual-apply application finishes tailoring |
| `application:applied_manually`       | `{ application_id, applied_at }` — fired when the user marks a manual-apply done                                      |
| `alert:created`                      | the new alert                                                                                                         |
| `alert:resolved`                     | `{ id }`                                                                                                              |
| `alert:dismissed`                    | `{ id }`                                                                                                              |
| `chat:token`                         | `{ message_id: string, token: string }` — for streaming assistant output                                              |
| `chat:message`                       | full message row, sent at the end of an assistant turn                                                                |
| `site:login_status`                  | `{ login_id, status, reason? }`                                                                                       |
| `system:status`                      | full status object — sent on subscribe and every 5s while connected                                                   |
| `queue:updated`                      | `{ pending: number, running: number }`                                                                                |
| `search:cancelled`                   | `{ task_id, site_id, listings_added, scored }` — fired when a search task is cancelled (by the handler if running, or by the cancel route if the task was in retry backoff) |

### Client → Server envelope

The WS is mostly server→client. The only client-initiated message is a heartbeat `{ type: 'ping' }` which the server replies to with `{ type: 'pong' }`.

### Close codes

When the server closes the socket it uses the following codes. The frontend reconnect loop only retries on `1006` and standard transient codes — it stops retrying on `4401` (the token will not become valid by retrying).

| Code   | Meaning                                                                                                                                                  |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `4401` | Unauthorized — bearer token missing, malformed, or does not match the per-process token in `/api/bootstrap`. Client must refetch bootstrap before reconnecting. |
| `1000` | Normal closure (server shutting down or client navigated away).                                                                                          |
| `1006` | Abnormal closure (network blip, daemon crash). Reconnect with exponential backoff up to 30s.                                                             |

Codes in the `4xxx` range are application-defined per RFC 6455 and reserved for Vina-specific failures; the `1xxx` range follows the standard.

## Pagination

Cursor-based for lists that can grow:

- Request: `?limit=50&cursor=<opaque>`
- Response: `{ items: [...], next_cursor: string | null }`

The opaque cursor is a base64 of `{ created_at, id }` so it sorts deterministically.

## Rate Limiting

Not in MVP — the server is local and single-user.

## Versioning

The bearer token also encodes a version stamp; if the frontend's bundled version differs from the server's, the bootstrap response includes `version_mismatch: true` and the frontend prompts the user to refresh. (When CLI updates the package, the daemon restart picks up the new version.)
