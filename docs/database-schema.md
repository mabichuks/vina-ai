# Database Schema

SQLite via `better-sqlite3`. WAL mode. Migrations are forward-only SQL files in `packages/server/migrations/` named `NNN_description.sql`.

## Conventions

- All primary keys are `TEXT` storing ULIDs (sortable, no central counter)
- All timestamps are ISO-8601 strings in UTC, stored as `TEXT`
- Booleans are `INTEGER` 0/1
- Enums are `TEXT` with `CHECK` constraints — keep enum values in `packages/shared/src/enums.ts` and mirror in `CHECK` clauses
- All foreign keys cascade on delete unless noted otherwise

## Tables

### `profile`

Single-row table. The user's identity and reusable defaults.

| Column         | Type          | Notes                                                |
| -------------- | ------------- | ---------------------------------------------------- |
| `id`           | TEXT PK       | Always `'me'` (single-row constraint via UNIQUE)     |
| `full_name`    | TEXT NOT NULL |                                                      |
| `email`        | TEXT NOT NULL |                                                      |
| `phone`        | TEXT          |                                                      |
| `location`     | TEXT          | Free-form, e.g. "Bromborough, UK"                    |
| `linkedin_url` | TEXT          |                                                      |
| `website_url`  | TEXT          |                                                      |
| `bio`          | TEXT          | Free-prose self-description used by the orchestrator |
| `created_at`   | TEXT NOT NULL |                                                      |
| `updated_at`   | TEXT NOT NULL |                                                      |

### `cvs`

Uploaded CVs. Multiple per profile.

| Column              | Type                       | Notes                                                                                               |
| ------------------- | -------------------------- | --------------------------------------------------------------------------------------------------- |
| `id`                | TEXT PK                    |                                                                                                     |
| `label`             | TEXT NOT NULL              | User-supplied name, e.g. "Senior Backend"                                                           |
| `original_filename` | TEXT NOT NULL              |                                                                                                     |
| `mime_type`         | TEXT NOT NULL CHECK        | One of `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| `file_path`         | TEXT NOT NULL              | Relative to data dir                                                                                |
| `extracted_text`    | TEXT                       | Plain-text extraction for LLM consumption                                                           |
| `is_default`        | INTEGER NOT NULL DEFAULT 0 | At most one row may be 1 (enforced in application code, not SQL)                                    |
| `created_at`        | TEXT NOT NULL              |                                                                                                     |

### `cover_letters`

Optional uploaded cover letters. Same shape as `cvs`.

| Column              | Type                       | Notes |
| ------------------- | -------------------------- | ----- |
| `id`                | TEXT PK                    |       |
| `label`             | TEXT NOT NULL              |       |
| `original_filename` | TEXT NOT NULL              |       |
| `mime_type`         | TEXT NOT NULL              |       |
| `file_path`         | TEXT NOT NULL              |       |
| `extracted_text`    | TEXT                       |       |
| `is_default`        | INTEGER NOT NULL DEFAULT 0 |       |
| `created_at`        | TEXT NOT NULL              |       |

### `search_preferences`

Single-row in MVP (one preference set per user).

| Column               | Type                        | Notes                                                                                                      |
| -------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `id`                 | TEXT PK                     | Always `'default'`                                                                                         |
| `description`        | TEXT NOT NULL               | Prose description: "Senior backend roles, remote, EU timezone"                                             |
| `keywords`           | TEXT NOT NULL               | JSON array of strings                                                                                      |
| `locations`          | TEXT NOT NULL               | JSON array of strings                                                                                      |
| `work_models`        | TEXT NOT NULL               | JSON array, subset of `['remote','hybrid','onsite']`                                                       |
| `seniority`          | TEXT NOT NULL               | JSON array, subset of `['intern','junior','mid','senior','staff','principal','lead','manager','director']` |
| `min_salary`         | INTEGER                     | nullable                                                                                                   |
| `max_salary`         | INTEGER                     | nullable                                                                                                   |
| `salary_currency`    | TEXT                        | ISO 4217, nullable                                                                                         |
| `excluded_companies` | TEXT NOT NULL DEFAULT '[]'  | JSON array                                                                                                 |
| `score_threshold`    | INTEGER NOT NULL DEFAULT 70 | Minimum match score to auto-apply (autonomous mode)                                                        |
| `updated_at`         | TEXT NOT NULL               |                                                                                                            |

### `settings`

Single-row global app settings.

| Column                   | Type                       | Notes                                            |
| ------------------------ | -------------------------- | ------------------------------------------------ |
| `id`                     | TEXT PK                    | Always `'app'`                                   |
| `mode`                   | TEXT NOT NULL CHECK        | `'autonomous'` or `'supervised'`                 |
| `approval`               | TEXT NOT NULL CHECK        | `'auto-apply'` or `'review-first'`               |
| `browser_headful`        | INTEGER NOT NULL DEFAULT 0 | If 1, Playwright is visible                      |
| `browser_stealth`        | INTEGER NOT NULL DEFAULT 0 | If 1, opt-in anti-detection masking (ADR-021)    |
| `paused`                 | INTEGER NOT NULL DEFAULT 0 | If 1, scheduler is paused                        |
| `active_llm_provider_id` | TEXT                       | FK → `llm_providers.id`                          |
| `encrypted_serpapi_key`  | BLOB                       | nullable; only present if Google Jobs is enabled |
| `updated_at`             | TEXT NOT NULL              |                                                  |

### `schedules`

Cron schedules. MVP supports a single schedule but the table is plural for future-proofing.

| Column            | Type                       | Notes                                 |
| ----------------- | -------------------------- | ------------------------------------- |
| `id`              | TEXT PK                    |                                       |
| `cron_expression` | TEXT NOT NULL              | Standard 5-field cron                 |
| `enabled`         | INTEGER NOT NULL DEFAULT 1 |                                       |
| `last_run_at`     | TEXT                       |                                       |
| `next_run_at`     | TEXT                       | Computed and updated by the scheduler |
| `created_at`      | TEXT NOT NULL              |                                       |

### `llm_providers`

Configured LLM endpoints. Only one is "active" at a time (see `settings.active_llm_provider_id`).

| Column              | Type                | Notes                                           |
| ------------------- | ------------------- | ----------------------------------------------- |
| `id`                | TEXT PK             |                                                 |
| `kind`              | TEXT NOT NULL CHECK | One of `'anthropic'`, `'openai'`, `'ollama'`    |
| `label`             | TEXT NOT NULL       | Display name                                    |
| `model`             | TEXT NOT NULL       | e.g. `claude-opus-4-7`, `gpt-5`, `llama3.1:70b` |
| `base_url`          | TEXT                | nullable; for Ollama or custom endpoints        |
| `encrypted_api_key` | BLOB                | nullable; null for local Ollama                 |
| `created_at`        | TEXT NOT NULL       |                                                 |

### `sites`

The job sources Vina is configured for. Seeded with `'linkedin'`, `'indeed'`, and `'google'`.

| Column             | Type                       | Notes                                                                                                          |
| ------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `id`               | TEXT PK                    | e.g. `'linkedin'`, `'indeed'`, `'google'`                                                                      |
| `display_name`     | TEXT NOT NULL              |                                                                                                                |
| `kind`             | TEXT NOT NULL CHECK        | `'browser'` (uses Playwright session) or `'api'` (uses an API key from settings, e.g. SerpAPI for Google Jobs) |
| `enabled`          | INTEGER NOT NULL DEFAULT 0 |                                                                                                                |
| `session_path`     | TEXT                       | Path to Playwright `storageState` JSON. nullable for `kind='api'`                                              |
| `session_valid_at` | TEXT                       | Last time we successfully used the session. nullable for `kind='api'`                                          |
| `last_search_at`   | TEXT                       |                                                                                                                |

`kind='api'` rows do not require interactive login; they validate via the API key in `settings`. The `google` row is `kind='api'` and is enabled iff a valid `encrypted_serpapi_key` is present.

### `jobs`

Discovered listings.

| Column                | Type                | Notes                                                                                                                                                                                            |
| --------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                  | TEXT PK             |                                                                                                                                                                                                  |
| `site_id`             | TEXT NOT NULL       | FK → `sites.id`                                                                                                                                                                                  |
| `external_id`         | TEXT NOT NULL       | The site's own job ID, used for dedup                                                                                                                                                            |
| `url`                 | TEXT NOT NULL       | The Vina-side or aggregator URL                                                                                                                                                                  |
| `external_apply_url`  | TEXT                | nullable. For manual-apply jobs, the destination URL the user opens to apply (e.g. company ATS)                                                                                                  |
| `apply_method`        | TEXT NOT NULL CHECK | `'auto'` (Vina submits via Playwright) or `'manual'` (user submits externally)                                                                                                                   |
| `original_source`     | TEXT                | nullable. For Google Jobs, the underlying source surfaced by Google (e.g. "Greenhouse", "Dice", "via LinkedIn"). null for native LinkedIn/Indeed jobs                                            |
| `title`               | TEXT NOT NULL       |                                                                                                                                                                                                  |
| `company`             | TEXT NOT NULL       |                                                                                                                                                                                                  |
| `location`            | TEXT                |                                                                                                                                                                                                  |
| `description`         | TEXT NOT NULL       |                                                                                                                                                                                                  |
| `salary_text`         | TEXT                | nullable, free-form                                                                                                                                                                              |
| `posted_at`           | TEXT                |                                                                                                                                                                                                  |
| `discovered_at`       | TEXT NOT NULL       |                                                                                                                                                                                                  |
| `match_score`         | INTEGER             | 0–100, null until scored                                                                                                                                                                         |
| `match_justification` | TEXT                | One-line LLM justification                                                                                                                                                                       |
| `status`              | TEXT NOT NULL CHECK | `'new'`, `'scored'`, `'queued'`, `'applying'`, `'awaiting_user'`, `'awaiting_approval'`, `'ready_for_manual_apply'`, `'submitted'`, `'applied_manually'`, `'failed'`, `'skipped'`, `'dismissed'` |
|                       |                     | UNIQUE(`site_id`, `external_id`)                                                                                                                                                                 |

`apply_method` is determined at discovery:

- LinkedIn / Indeed: detected from the listing markup (Easy Apply / Quick Apply badge ⇒ `auto`; external redirect indicator ⇒ `manual`)
- Google Jobs: always `manual`

### `applications`

A single attempt to apply to a job. A job can have multiple applications only on retry.

| Column                       | Type                | Notes                                                                                                                                                        |
| ---------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                         | TEXT PK             |                                                                                                                                                              |
| `job_id`                     | TEXT NOT NULL       | FK → `jobs.id`                                                                                                                                               |
| `cv_id`                      | TEXT NOT NULL       | FK → `cvs.id` (the source CV)                                                                                                                                |
| `cover_letter_id`            | TEXT                | FK → `cover_letters.id` (nullable)                                                                                                                           |
| `apply_method`               | TEXT NOT NULL CHECK | Mirrors `jobs.apply_method` at the time the application is created                                                                                           |
| `tailored_cv_path`           | TEXT                | Relative path to the tailored DOCX                                                                                                                           |
| `tailored_cover_letter_path` | TEXT                | nullable                                                                                                                                                     |
| `status`                     | TEXT NOT NULL CHECK | `'queued'`, `'applying'`, `'awaiting_user'`, `'awaiting_approval'`, `'ready_for_manual_apply'`, `'submitted'`, `'applied_manually'`, `'failed'`, `'skipped'` |
| `started_at`                 | TEXT NOT NULL       |                                                                                                                                                              |
| `submitted_at`               | TEXT                | nullable. Set when an auto-apply application reaches `submitted`                                                                                             |
| `applied_manually_at`        | TEXT                | nullable. Set when the user marks a manual-apply application as done                                                                                         |
| `applied_manually_notes`     | TEXT                | nullable. Free-text notes the user entered when marking applied                                                                                              |
| `failure_reason`             | TEXT                |                                                                                                                                                              |
| `form_state`                 | TEXT                | JSON snapshot of last known form state, used to resume                                                                                                       |

State transition notes:

- `apply_method='auto'` applications follow: `queued` → `applying` → (`awaiting_user` ⇄ `applying`) → `submitted` | `failed` | `skipped`
- `apply_method='manual'` applications follow: `queued` → `ready_for_manual_apply` → `applied_manually` | `skipped`
- `awaiting_approval` is reachable from either when the user is in review-first mode (auto) or has not yet reviewed the tailored CV (manual)

### `application_events`

Append-only timeline per application.

| Column            | Type                | Notes                                                                                                                                                                                                                                                              |
| ----------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`              | TEXT PK             |                                                                                                                                                                                                                                                                    |
| `application_id`  | TEXT NOT NULL       |                                                                                                                                                                                                                                                                    |
| `kind`            | TEXT NOT NULL CHECK | One of `'created'`, `'cv_tailored'`, `'cv_approved'`, `'cv_rejected'`, `'apply_started'`, `'field_filled'`, `'field_unknown'`, `'captcha_detected'`, `'session_expired'`, `'submitted'`, `'failed'`, `'resumed'`, `'ready_for_manual_apply'`, `'applied_manually'` |
| `payload`         | TEXT                | JSON, kind-specific                                                                                                                                                                                                                                                |
| `screenshot_path` | TEXT                | nullable                                                                                                                                                                                                                                                           |
| `created_at`      | TEXT NOT NULL       |                                                                                                                                                                                                                                                                    |

### `alerts`

Items needing user attention. Surfaced in the chatbot and alerts tab.

| Column             | Type                | Notes                                                                                                                                 |
| ------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | TEXT PK             |                                                                                                                                       |
| `kind`             | TEXT NOT NULL CHECK | `'missing_field'`, `'captcha'`, `'session_expired'`, `'awaiting_approval'`, `'apply_failed'`, `'ready_for_manual_apply'`, `'general'` |
| `severity`         | TEXT NOT NULL CHECK | `'info'`, `'action_required'`, `'error'`                                                                                              |
| `title`            | TEXT NOT NULL       |                                                                                                                                       |
| `description`      | TEXT NOT NULL       |                                                                                                                                       |
| `application_id`   | TEXT                | nullable FK                                                                                                                           |
| `site_id`          | TEXT                | nullable FK                                                                                                                           |
| `payload`          | TEXT                | JSON, e.g. `{ field: 'years_of_experience', prompt: '...' }` or `{ external_apply_url: '...' }`                                       |
| `status`           | TEXT NOT NULL CHECK | `'open'`, `'resolved'`, `'dismissed'`                                                                                                 |
| `resolution_value` | TEXT                | nullable, the user's answer for missing-field alerts                                                                                  |
| `created_at`       | TEXT NOT NULL       |                                                                                                                                       |
| `resolved_at`      | TEXT                |                                                                                                                                       |

The `ready_for_manual_apply` alert kind is created when a manual-apply application finishes tailoring. It is auto-resolved when the user marks the application as `applied_manually`.

### `profile_answers`

Reusable answers to common application questions, populated as the user resolves alerts.

| Column       | Type                 | Notes                                                                                    |
| ------------ | -------------------- | ---------------------------------------------------------------------------------------- |
| `id`         | TEXT PK              |                                                                                          |
| `key`        | TEXT NOT NULL UNIQUE | Canonical key, e.g. `years_of_experience`, `work_authorization_uk`, `salary_expectation` |
| `label`      | TEXT NOT NULL        | Human-readable                                                                           |
| `value`      | TEXT NOT NULL        |                                                                                          |
| `created_at` | TEXT NOT NULL        |                                                                                          |
| `updated_at` | TEXT NOT NULL        |                                                                                          |

The orchestrator looks up answers by `key` before raising a missing-field alert.

### `chat_messages`

Persistent chatbot transcript.

| Column         | Type                | Notes                                         |
| -------------- | ------------------- | --------------------------------------------- |
| `id`           | TEXT PK             |                                               |
| `role`         | TEXT NOT NULL CHECK | `'user'`, `'assistant'`, `'tool'`, `'system'` |
| `content`      | TEXT NOT NULL       |                                               |
| `tool_call_id` | TEXT                | nullable, when the message is a tool result   |
| `metadata`     | TEXT                | JSON, e.g. references to alerts               |
| `created_at`   | TEXT NOT NULL       |                                               |

The chatbot uses a sliding window of the most recent N messages plus the user's profile and answer book as context. See `langgraph-orchestrator.md`.

### `task_queue`

Persistent queue. The worker reads from this on startup to recover.

| Column            | Type                       | Notes                                                                              |
| ----------------- | -------------------------- | ---------------------------------------------------------------------------------- |
| `id`              | TEXT PK                    |                                                                                    |
| `kind`            | TEXT NOT NULL CHECK        | `'search'`, `'score'`, `'tailor'`, `'apply'`, `'prepare_manual_apply'`, `'resume'` |
| `payload`         | TEXT NOT NULL              | JSON                                                                               |
| `priority`        | INTEGER NOT NULL DEFAULT 0 | Higher = sooner                                                                    |
| `attempts`        | INTEGER NOT NULL DEFAULT 0 |                                                                                    |
| `max_attempts`    | INTEGER NOT NULL DEFAULT 3 |                                                                                    |
| `next_attempt_at` | TEXT NOT NULL              |                                                                                    |
| `started_at`      | TEXT                       |                                                                                    |
| `failed_reason`   | TEXT                       |                                                                                    |
| `status`          | TEXT NOT NULL CHECK        | `'pending'`, `'running'`, `'completed'`, `'failed'`, `'cancelled'`                 |
| `created_at`      | TEXT NOT NULL              |                                                                                    |

`prepare_manual_apply` is the manual-apply equivalent of `apply` — it runs CV (and optional cover letter) tailoring, then transitions the application to `ready_for_manual_apply` without invoking browser automation.

### `audit_log`

Optional but recommended. Records significant state changes — useful for support and the timeline view.

| Column       | Type          | Notes                                                      |
| ------------ | ------------- | ---------------------------------------------------------- |
| `id`         | TEXT PK       |                                                            |
| `entity`     | TEXT NOT NULL | e.g. `application`, `alert`, `setting`                     |
| `entity_id`  | TEXT NOT NULL |                                                            |
| `action`     | TEXT NOT NULL | e.g. `status_change`, `created`, `marked_applied_manually` |
| `before`     | TEXT          | JSON                                                       |
| `after`      | TEXT          | JSON                                                       |
| `created_at` | TEXT NOT NULL |                                                            |

## Indexes

```sql
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_score ON jobs(match_score DESC);
CREATE INDEX idx_jobs_apply_method ON jobs(apply_method, status);
CREATE INDEX idx_applications_status ON applications(status);
CREATE INDEX idx_applications_apply_method ON applications(apply_method, status);
CREATE INDEX idx_alerts_status ON alerts(status, created_at);
CREATE INDEX idx_events_app ON application_events(application_id, created_at);
CREATE INDEX idx_queue_pending ON task_queue(status, next_attempt_at);
```

## Migrations

Migrations live at `packages/server/migrations/` and are applied in lexical order on startup. The first migration creates all tables above, including the new `apply_method`, `external_apply_url`, `original_source`, `applied_manually_at`, `applied_manually_notes`, and `encrypted_serpapi_key` columns. The first migration also seeds `sites` with rows for `linkedin`, `indeed`, and `google`. A `_migrations` table tracks applied versions.

A simple migration runner:

```ts
const applied = db
  .prepare('SELECT id FROM _migrations')
  .all()
  .map((r) => r.id);
for (const file of fs.readdirSync(migrationsDir).sort()) {
  if (applied.includes(file)) continue;
  const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
  db.exec('BEGIN');
  try {
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)').run(
      file,
      new Date().toISOString(),
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
```
