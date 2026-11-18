-- 010_external_apply_mode.sql
-- Adds the single `external_apply_mode` setting (ADR-024 §7 three-mode routing)
-- and the `external_form_fill` task kind (issue #21).
--
-- `external_apply_mode` mirrors the ADR-023 single-mode collapse: one enum
-- column, default 'manual', no per-mode sub-toggle. `manual` keeps ADR-016
-- behaviour (materials only); `assisted`/`autonomous` enable the Playwright-MCP
-- external form fill.
--
-- `external_form_fill` is a new task_queue kind (spawns the `vina-manual`
-- session). SQLite cannot alter a CHECK constraint, so task_queue is rebuilt
-- with the new kind added to the allowlist (same pattern as 009 for `review`).

ALTER TABLE settings
  ADD COLUMN external_apply_mode TEXT NOT NULL DEFAULT 'manual'
  CHECK (external_apply_mode IN ('manual', 'assisted', 'autonomous'));

-- Widen application_events.kind to the four external-form-fill event kinds.
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt (same pattern
-- as 002/003 did for alerts.kind).
CREATE TABLE application_events_new (
  id              TEXT PRIMARY KEY,
  application_id  TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'created', 'cv_tailored', 'cv_approved', 'cv_rejected',
                    'apply_started', 'field_filled', 'field_unknown',
                    'captcha_detected', 'session_expired',
                    'submitted', 'failed', 'resumed',
                    'ready_for_manual_apply', 'applied_manually',
                    'external_form_opened', 'external_field_filled',
                    'external_ready_for_review', 'external_submitted'
                  )),
  payload         TEXT,
  screenshot_path TEXT,
  created_at      TEXT NOT NULL
);

INSERT INTO application_events_new
  (id, application_id, kind, payload, screenshot_path, created_at)
SELECT id, application_id, kind, payload, screenshot_path, created_at
FROM application_events;

DROP TABLE application_events;
ALTER TABLE application_events_new RENAME TO application_events;

CREATE INDEX idx_events_app ON application_events(application_id, created_at);

CREATE TABLE task_queue_new (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'search', 'score', 'tailor', 'apply',
                    'prepare_manual_apply', 'review', 'resume',
                    'external_form_fill'
                  )),
  payload         TEXT NOT NULL,
  priority        INTEGER NOT NULL DEFAULT 0,
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts    INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  next_attempt_at TEXT NOT NULL,
  started_at      TEXT,
  failed_reason   TEXT,
  status          TEXT NOT NULL CHECK (status IN (
                    'pending', 'running', 'completed', 'failed', 'cancelled'
                  )),
  created_at      TEXT NOT NULL
);

INSERT INTO task_queue_new
  (id, kind, payload, priority, attempts, max_attempts,
   next_attempt_at, started_at, failed_reason, status, created_at)
SELECT
  id, kind, payload, priority, attempts, max_attempts,
  next_attempt_at, started_at, failed_reason, status, created_at
FROM task_queue;

DROP TABLE task_queue;
ALTER TABLE task_queue_new RENAME TO task_queue;

CREATE INDEX idx_queue_pending ON task_queue(status, next_attempt_at);
