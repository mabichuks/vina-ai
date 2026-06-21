-- Collapse `mode` × `approval` into a single `easy_apply_mode` setting.
-- Add gate-config columns + a persistent rate-limit row.
-- No production users yet; we drop the old columns outright instead of
-- migrating values.

ALTER TABLE settings DROP COLUMN mode;
ALTER TABLE settings DROP COLUMN approval;

ALTER TABLE settings
  ADD COLUMN easy_apply_mode TEXT NOT NULL DEFAULT 'manual'
  CHECK (easy_apply_mode IN ('autonomous', 'manual'));

ALTER TABLE settings
  ADD COLUMN autonomous_apply_dry_run INTEGER NOT NULL DEFAULT 0
  CHECK (autonomous_apply_dry_run IN (0, 1));

ALTER TABLE settings
  ADD COLUMN apply_daily_cap INTEGER NOT NULL DEFAULT 10
  CHECK (apply_daily_cap >= 1 AND apply_daily_cap <= 100);

-- 0 = no throttle (every other limit starts at 1; this one allows opting out)
ALTER TABLE settings
  ADD COLUMN apply_min_interval_seconds INTEGER NOT NULL DEFAULT 300
  CHECK (apply_min_interval_seconds >= 0 AND apply_min_interval_seconds <= 3600);

ALTER TABLE settings
  ADD COLUMN apply_listing_max_age_days INTEGER NOT NULL DEFAULT 14
  CHECK (apply_listing_max_age_days >= 1 AND apply_listing_max_age_days <= 365);

ALTER TABLE settings
  ADD COLUMN apply_consecutive_failure_limit INTEGER NOT NULL DEFAULT 5
  CHECK (apply_consecutive_failure_limit >= 1 AND apply_consecutive_failure_limit <= 50);

CREATE TABLE apply_rate_limit (
  id                   TEXT PRIMARY KEY CHECK (id = 'app'),
  successful_today     INTEGER NOT NULL DEFAULT 0 CHECK (successful_today >= 0),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_attempt_at      TEXT,
  last_success_at      TEXT,
  day_bucket           TEXT NOT NULL
);

INSERT INTO apply_rate_limit (id, day_bucket)
VALUES ('app', strftime('%Y-%m-%d', 'now', 'localtime'));

-- Seed the singleton settings row if it does not yet exist.
-- In a fresh DB (or after dropping mode/approval) the row must be present so
-- the new column defaults are reachable without a separate bootstrap step.
INSERT OR IGNORE INTO settings (id, updated_at)
VALUES ('app', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
