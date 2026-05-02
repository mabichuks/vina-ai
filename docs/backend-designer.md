# Backend Design — `packages/server`

The Fastify-based service that owns persistence, scheduling, queueing, and the HTTP/WebSocket gateway.

## 1. Folder Layout

```
packages/server/
├── src/
│   ├── index.ts              # createServer(); not the entrypoint
│   ├── main.ts               # entrypoint used by the CLI when starting the daemon
│   ├── config.ts             # paths, port, env resolution via env-paths
│   ├── db/
│   │   ├── client.ts         # better-sqlite3 singleton, WAL mode
│   │   ├── migrate.ts        # migration runner
│   │   └── repositories/     # one file per table; pure data access, no business logic
│   ├── http/
│   │   ├── app.ts            # Fastify app factory
│   │   ├── auth.ts           # bearer-token middleware
│   │   ├── routes/           # one file per resource: profile, cvs, jobs, applications, alerts, settings, sites, llm, chat, system
│   │   └── ws.ts             # WebSocket gateway
│   ├── services/             # business logic. routes call services; services call repositories + orchestrator + automation + serpapi
│   │   ├── profile-service.ts
│   │   ├── job-service.ts
│   │   ├── application-service.ts
│   │   ├── alert-service.ts
│   │   ├── chat-service.ts
│   │   ├── llm-service.ts
│   │   ├── site-service.ts
│   │   ├── settings-service.ts
│   │   └── serpapi-service.ts   # Google Jobs discovery via SerpAPI
│   ├── scheduler/
│   │   ├── scheduler.ts      # node-cron driver
│   │   └── tasks.ts          # task definitions: searchTask, scoreTask, applyTask, prepareManualApplyTask, resumeTask
│   ├── queue/
│   │   ├── queue.ts          # p-queue + persistence
│   │   └── runner.ts         # the worker loop
│   ├── secrets/
│   │   └── vault.ts          # encrypt/decrypt API keys (keytar with file fallback)
│   ├── files/
│   │   └── storage.ts        # safe file paths under data dir; CV/cover-letter/screenshot helpers
│   ├── events/
│   │   └── bus.ts            # in-process EventEmitter; WebSocket gateway subscribes
│   └── lib/
│       ├── errors.ts         # VinaError hierarchy
│       ├── logger.ts         # pino instance
│       └── ulid.ts           # id helper
├── migrations/
│   └── 001_init.sql
├── package.json
└── tsconfig.json
```

## 2. Module Responsibilities

### Repositories

- One file per table. Export functions, not classes. e.g. `findJobById`, `insertJob`, `updateJobStatus`
- Take a `Database` instance as the first argument so they're easy to test
- No cross-table joins beyond what the table directly needs; cross-cutting reads belong in services

### Services

- Where business logic lives. The only layer that calls multiple repositories, the orchestrator, the automation package, and external APIs (SerpAPI)
- Each public service function maps to a discrete user intent or queue task
- Services emit events on the bus (`'application:updated'`, `'alert:created'`, etc.); the WebSocket gateway forwards them

### `serpapi-service.ts`

A thin client over SerpAPI's Google Jobs endpoint. Public surface:

```ts
export async function searchGoogleJobs(
  prefs: SearchPreferences,
  apiKey: string,
): AsyncIterable<RawListing>;
export async function validateSerpApiKey(
  apiKey: string,
): Promise<{ ok: true; latency_ms: number } | { ok: false; reason: string }>;
```

Implementation notes:

- Builds query params from `SearchPreferences` (q, location, gl, hl)
- Paginates through results until exhausted or until `MAX_RESULTS_PER_RUN` (default 100) is reached
- Yields `RawListing` objects shaped identically to those produced by Playwright adapters, with `apply_method = 'manual'`, `external_apply_url` populated from `apply_options[0].link`, and `original_source` from the `via` field
- Handles 429 with exponential backoff
- Times out after 30s per page

The service does not depend on the orchestrator or automation packages — it only depends on `@vina/shared` (types) and a small fetch helper. This keeps it easy to swap for a different scraper in future.

### Routes

- Fastify route handlers are thin. They:
  1. Validate the request (zod schema from `@vina/shared`)
  2. Call exactly one service function
  3. Format the response
- No business logic, no DB access from routes

### Scheduler

- Loads all enabled `schedules` rows on startup, registers a cron job for each
- Each tick enqueues a `search` task per enabled site (browser-kind and api-kind)

### Queue / Worker

- `task_queue` table is the source of truth for pending work
- A `p-queue` per task kind (`search`, `apply`, `prepare_manual_apply`, etc.) with kind-specific concurrency:
  - `search`: 1 per source
  - `apply`: 1 globally (auto-apply uses the browser, sequential for safety)
  - `prepare_manual_apply`: 2 (no browser involvement; bounded by LLM rate limits)
- On startup, all `pending` rows whose `next_attempt_at` is past are re-enqueued; `running` rows are reset to `pending` (assume crash)
- Each task handler is registered in `tasks.ts` and resolved by `kind`
- On failure, increments `attempts`, sets `next_attempt_at = now + backoff(attempts)` if attempts < max; otherwise marks `failed`

Task dispatch by site kind:

- `search` task with `site_id` of a `kind='browser'` site → runs via the relevant Playwright adapter
- `search` task with `site_id='google'` → runs via `serpapi-service.searchGoogleJobs`

After search:

- For each new job inserted, enqueue a `score` task
- After scoring, in autonomous mode, enqueue:
  - `apply` if `apply_method='auto'` and score ≥ threshold
  - `prepare_manual_apply` if `apply_method='manual'` and score ≥ threshold
- In supervised mode, no auto-enqueue — the user kicks tasks off via `POST /api/jobs/:id/apply`

### Secrets vault

- API keys are encrypted with AES-256-GCM. Master key is sourced from:
  1. `keytar` (OS keychain) if available
  2. Otherwise a `~/<data-dir>/.master.key` file with `0600` permissions, generated on first run
- `vault.encrypt(plaintext): Buffer`, `vault.decrypt(ciphertext): string`
- Used for both `llm_providers.encrypted_api_key` and `settings.encrypted_serpapi_key`
- Decrypted keys are kept in memory only for the duration of an LLM call or SerpAPI call

### Events bus

- A typed `EventEmitter`. Defined event names in `@vina/shared/events.ts`:
  - `jobs:updated`
  - `application:updated`
  - `application:ready_for_manual_apply`
  - `application:applied_manually`
  - `alert:created` / `alert:resolved`
  - `chat:message`
  - `system:status`
- The WebSocket gateway subscribes and pushes JSON envelopes to connected clients

## 3. Startup Sequence

1. Resolve paths via `env-paths`, ensure they exist
2. Open SQLite (`vina.db`), enable WAL, run pending migrations
3. Initialise the secrets vault
4. Construct the EventEmitter and Fastify app
5. Register routes and the WebSocket gateway
6. Bind to `127.0.0.1` on the configured port (default 7341, or `--port` from CLI)
7. Resume the queue: reset stale `running` rows, requeue `pending`
8. Start the scheduler
9. Write the status file (`vina.status`)
10. Log "ready" with port + URL

## 4. Shutdown Sequence

On `SIGTERM`:

1. Stop accepting new HTTP connections
2. Close all WebSocket connections
3. Stop the scheduler (no more cron firings)
4. Stop the queue runner; in-flight tasks get `cancelled = true` cooperatively
5. Wait up to 30s for in-flight tasks to wrap up; force-quit thereafter
6. Close Playwright contexts (they're persistent; storage state is auto-saved by Playwright on close)
7. Close the database
8. Delete `vina.pid` and `vina.status`
9. Exit 0

## 5. Configuration

`config.ts` resolves at startup:

```ts
{
  port: number,             // default 7341
  dataDir: string,          // env-paths('vina').data
  logsDir: string,          // dataDir + '/logs'
  filesDir: string,         // dataDir + '/files'
  sessionsDir: string,      // dataDir + '/sessions'
  bearerToken: string,      // generated per-process
  logLevel: 'info' | 'debug' | 'warn' | 'error',
  headfulBrowser: boolean   // mirrors settings.browser_headful at startup
}
```

CLI flags override env vars override defaults. There is no system-wide config file.

## 6. Logging

- `pino` with one logger per module, `child({ module: 'queue' })` etc.
- Log file under `logsDir/vina.log`, rotated daily (`pino-roll`)
- Sensitive values (API keys, cookies) must be redacted via `pino`'s redaction config — including `serpapi_key`

## 7. Errors

A small hierarchy in `lib/errors.ts`:

```ts
class VinaError extends Error {
  code: string;
  status?: number;
  details?: unknown;
}
class ValidationError extends VinaError {
  /* 400 */
}
class NotFoundError extends VinaError {
  /* 404 */
}
class AuthError extends VinaError {
  /* 401 */
}
class ConflictError extends VinaError {
  /* 409 */
}
class ProviderError extends VinaError {
  /* 502 — LLM, SerpAPI, etc. */
}
class AutomationError extends VinaError {
  /* 502 — Playwright */
}
```

Fastify's error handler converts `VinaError` to a JSON envelope `{ code, message, details }`. Anything else becomes a 500 with a generic message; the original is logged with the request id.

## 8. Validation

Every route uses a zod schema from `@vina/shared/schemas/`. Schemas are the single source of truth for the request/response shapes — the frontend imports the same schemas to type its API client.

## 9. Testing

- Unit tests with Vitest, colocated as `*.test.ts`
- Repository tests use an in-memory SQLite (`:memory:`)
- Service tests mock repositories, the orchestrator, and the SerpAPI client
- Integration tests for routes spin up Fastify with a temporary DB
- `serpapi-service` tests use a fixture HTTP server returning canned SerpAPI responses
- End-to-end tests live in `tests/e2e/` and exercise the CLI + web UI against fixture sites — see `browser-automation.md` for fixture strategy

## 10. Dependencies (Allowed)

```
fastify
@fastify/websocket
@fastify/static
better-sqlite3
node-cron
p-queue
pino, pino-pretty, pino-roll
zod
ulid
env-paths
keytar (optional, may fail to install on Linux without libsecret — handle absence gracefully)
@vina/shared
@vina/orchestrator
@vina/automation
```

For the SerpAPI client, use the `fetch` API built into Node.js 20+ — no additional dependency. Adding anything else requires a note in the PR.
