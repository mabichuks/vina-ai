-- 002_linkedin_e2e_schema.sql
-- Adds schedule failure tracking + widens alerts.kind for the LinkedIn slice.
-- Forward-only. SQLite cannot ALTER a CHECK constraint, so we rebuild `alerts`.

ALTER TABLE schedules ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE schedules ADD COLUMN paused INTEGER NOT NULL DEFAULT 0
  CHECK (paused IN (0, 1));

CREATE TABLE alerts_new (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN (
                     'missing_field', 'captcha', 'session_expired',
                     'awaiting_approval', 'apply_failed',
                     'ready_for_manual_apply', 'general',
                     'linkedin_session_expired', 'search_failed',
                     'score_failed', 'schedule_paused', 'provider_failed'
                   )),
  severity         TEXT NOT NULL CHECK (severity IN ('info', 'action_required', 'error')),
  title            TEXT NOT NULL,
  description      TEXT NOT NULL,
  application_id   TEXT REFERENCES applications(id) ON DELETE CASCADE,
  site_id          TEXT REFERENCES sites(id) ON DELETE CASCADE,
  payload          TEXT,
  status           TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolution_value TEXT,
  created_at       TEXT NOT NULL,
  resolved_at      TEXT
);

INSERT INTO alerts_new SELECT * FROM alerts;
DROP TABLE alerts;
ALTER TABLE alerts_new RENAME TO alerts;

CREATE INDEX idx_alerts_status ON alerts(status, created_at);
