-- 003_serpapi_alert_kinds.sql
-- Widens alerts.kind to include the three SerpAPI kinds for the Google Jobs slice.
-- Forward-only. SQLite cannot ALTER a CHECK constraint, so we rebuild `alerts`.

CREATE TABLE alerts_new (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN (
                     'missing_field', 'captcha', 'session_expired',
                     'awaiting_approval', 'apply_failed',
                     'ready_for_manual_apply', 'general',
                     'linkedin_session_expired', 'search_failed',
                     'score_failed', 'schedule_paused', 'provider_failed',
                     'serpapi_key_missing', 'serpapi_key_invalid',
                     'serpapi_quota_exhausted'
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
