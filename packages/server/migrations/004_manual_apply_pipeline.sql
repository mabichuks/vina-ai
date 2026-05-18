-- 004_manual_apply_pipeline.sql
-- Adds tailored_at to applications so the Ready-to-Apply UI can render
-- "Tailored Ns ago" without parsing application_events. Write-once, set by
-- the prepare_manual_apply handler when the tailored CV lands on disk.

ALTER TABLE applications ADD COLUMN tailored_at TEXT;
