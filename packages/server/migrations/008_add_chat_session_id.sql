-- Persist the OpenCode session id for the single `vina-chat` conversation so a
-- restart can resume the same session (ADR-024 §6 "session lifecycle"; issue #18).
-- NULL until the first chat turn creates the session.

ALTER TABLE settings
  ADD COLUMN chat_session_id TEXT;
