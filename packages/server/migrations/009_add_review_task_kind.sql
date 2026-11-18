-- 009_add_review_task_kind.sql
-- Adds the `review` task kind (ADR-024 stage 2: materials review runs in a
-- fresh `vina-review` session, one round per `ready_for_manual_apply`
-- application). SQLite cannot alter a CHECK constraint, so the task_queue
-- table is rebuilt with `review` added to the kind allowlist and the pending
-- index recreated.

CREATE TABLE task_queue_new (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'search', 'score', 'tailor', 'apply',
                    'prepare_manual_apply', 'review', 'resume'
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
