-- 001_init.sql
-- Initial Vina schema. Mirrors docs/database-schema.md.
-- Conventions: TEXT ULID primary keys, TEXT ISO-8601 UTC timestamps, INTEGER 0/1 booleans.

------------------------------------------------------------------------------
-- Profile / CVs / cover letters
------------------------------------------------------------------------------

CREATE TABLE profile (
  id           TEXT PRIMARY KEY CHECK (id = 'me'),
  full_name    TEXT NOT NULL,
  email        TEXT NOT NULL,
  phone        TEXT,
  location     TEXT,
  linkedin_url TEXT,
  website_url  TEXT,
  bio          TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE cvs (
  id                TEXT PRIMARY KEY,
  label             TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  mime_type         TEXT NOT NULL CHECK (mime_type IN (
                      'application/pdf',
                      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                    )),
  file_path         TEXT NOT NULL,
  extracted_text    TEXT,
  is_default        INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at        TEXT NOT NULL
);

CREATE TABLE cover_letters (
  id                TEXT PRIMARY KEY,
  label             TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  mime_type         TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  extracted_text    TEXT,
  is_default        INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at        TEXT NOT NULL
);

------------------------------------------------------------------------------
-- Search preferences / settings / schedules / LLM providers
------------------------------------------------------------------------------

CREATE TABLE search_preferences (
  id                 TEXT PRIMARY KEY CHECK (id = 'default'),
  description        TEXT NOT NULL,
  keywords           TEXT NOT NULL,
  locations          TEXT NOT NULL,
  work_models        TEXT NOT NULL,
  seniority          TEXT NOT NULL,
  min_salary         INTEGER,
  max_salary         INTEGER,
  salary_currency    TEXT,
  excluded_companies TEXT NOT NULL DEFAULT '[]',
  score_threshold    INTEGER NOT NULL DEFAULT 70,
  updated_at         TEXT NOT NULL
);

CREATE TABLE llm_providers (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('anthropic', 'openai', 'ollama')),
  label             TEXT NOT NULL,
  model             TEXT NOT NULL,
  base_url          TEXT,
  encrypted_api_key BLOB,
  created_at        TEXT NOT NULL
);

CREATE TABLE settings (
  id                      TEXT PRIMARY KEY CHECK (id = 'app'),
  mode                    TEXT NOT NULL CHECK (mode IN ('autonomous', 'supervised')),
  approval                TEXT NOT NULL CHECK (approval IN ('auto-apply', 'review-first')),
  browser_headful         INTEGER NOT NULL DEFAULT 0 CHECK (browser_headful IN (0, 1)),
  paused                  INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  active_llm_provider_id  TEXT REFERENCES llm_providers(id) ON DELETE RESTRICT,
  encrypted_serpapi_key   BLOB,
  updated_at              TEXT NOT NULL
);

CREATE TABLE schedules (
  id              TEXT PRIMARY KEY,
  cron_expression TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_run_at     TEXT,
  next_run_at     TEXT,
  created_at      TEXT NOT NULL
);

------------------------------------------------------------------------------
-- Sites (with seeds)
------------------------------------------------------------------------------

CREATE TABLE sites (
  id               TEXT PRIMARY KEY,
  display_name     TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('browser', 'api')),
  enabled          INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  session_path     TEXT,
  session_valid_at TEXT,
  last_search_at   TEXT
);

INSERT INTO sites (id, display_name, kind, enabled, session_path, session_valid_at, last_search_at) VALUES
  ('linkedin', 'LinkedIn',    'browser', 0, NULL, NULL, NULL),
  ('indeed',   'Indeed',      'browser', 0, NULL, NULL, NULL),
  ('google',   'Google Jobs', 'api',     0, NULL, NULL, NULL);

------------------------------------------------------------------------------
-- Jobs / applications / events
------------------------------------------------------------------------------

CREATE TABLE jobs (
  id                  TEXT PRIMARY KEY,
  site_id             TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  external_id         TEXT NOT NULL,
  url                 TEXT NOT NULL,
  external_apply_url  TEXT,
  apply_method        TEXT NOT NULL CHECK (apply_method IN ('auto', 'manual')),
  original_source     TEXT,
  title               TEXT NOT NULL,
  company             TEXT NOT NULL,
  location            TEXT,
  description         TEXT NOT NULL,
  salary_text         TEXT,
  posted_at           TEXT,
  discovered_at       TEXT NOT NULL,
  match_score         INTEGER CHECK (match_score IS NULL OR (match_score >= 0 AND match_score <= 100)),
  match_justification TEXT,
  status              TEXT NOT NULL CHECK (status IN (
                        'new', 'scored', 'queued', 'applying',
                        'awaiting_user', 'awaiting_approval', 'ready_for_manual_apply',
                        'submitted', 'applied_manually', 'failed', 'skipped', 'dismissed'
                      )),
  UNIQUE (site_id, external_id)
);

CREATE TABLE applications (
  id                         TEXT PRIMARY KEY,
  job_id                     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  cv_id                      TEXT NOT NULL REFERENCES cvs(id) ON DELETE RESTRICT,
  cover_letter_id            TEXT REFERENCES cover_letters(id) ON DELETE SET NULL,
  apply_method               TEXT NOT NULL CHECK (apply_method IN ('auto', 'manual')),
  tailored_cv_path           TEXT,
  tailored_cover_letter_path TEXT,
  status                     TEXT NOT NULL CHECK (status IN (
                               'queued', 'applying', 'awaiting_user', 'awaiting_approval',
                               'ready_for_manual_apply', 'submitted', 'applied_manually',
                               'failed', 'skipped'
                             )),
  started_at                 TEXT NOT NULL,
  submitted_at               TEXT,
  applied_manually_at        TEXT,
  applied_manually_notes     TEXT,
  failure_reason             TEXT,
  form_state                 TEXT
);

CREATE TABLE application_events (
  id              TEXT PRIMARY KEY,
  application_id  TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'created', 'cv_tailored', 'cv_approved', 'cv_rejected',
                    'apply_started', 'field_filled', 'field_unknown',
                    'captcha_detected', 'session_expired',
                    'submitted', 'failed', 'resumed',
                    'ready_for_manual_apply', 'applied_manually'
                  )),
  payload         TEXT,
  screenshot_path TEXT,
  created_at      TEXT NOT NULL
);

------------------------------------------------------------------------------
-- Alerts / profile answers / chat / queue / audit log
------------------------------------------------------------------------------

CREATE TABLE alerts (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN (
                     'missing_field', 'captcha', 'session_expired',
                     'awaiting_approval', 'apply_failed',
                     'ready_for_manual_apply', 'general'
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

CREATE TABLE profile_answers (
  id         TEXT PRIMARY KEY,
  key        TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL,
  value      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE chat_messages (
  id           TEXT PRIMARY KEY,
  role         TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  content      TEXT NOT NULL,
  tool_call_id TEXT,
  metadata     TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE task_queue (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'search', 'score', 'tailor', 'apply',
                    'prepare_manual_apply', 'resume'
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

CREATE TABLE audit_log (
  id         TEXT PRIMARY KEY,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  action     TEXT NOT NULL,
  before     TEXT,
  after      TEXT,
  created_at TEXT NOT NULL
);

------------------------------------------------------------------------------
-- Indexes (PRD-033)
------------------------------------------------------------------------------

CREATE INDEX idx_jobs_status         ON jobs(status);
CREATE INDEX idx_jobs_score          ON jobs(match_score DESC);
CREATE INDEX idx_jobs_apply_method   ON jobs(apply_method, status);
CREATE INDEX idx_applications_status ON applications(status);
CREATE INDEX idx_applications_apply_method ON applications(apply_method, status);
CREATE INDEX idx_alerts_status       ON alerts(status, created_at);
CREATE INDEX idx_events_app          ON application_events(application_id, created_at);
CREATE INDEX idx_queue_pending       ON task_queue(status, next_attempt_at);
