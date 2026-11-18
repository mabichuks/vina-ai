-- 011_ollama_cloud_provider.sql
-- Adds the `ollama-cloud` LLM provider kind (issue #35): a hosted Ollama reached
-- through the OpenAI-compatible endpoint https://ollama.com/v1 with an API key,
-- distinct from the keyless local `ollama` kind.
--
-- SQLite cannot alter a CHECK constraint, so llm_providers is rebuilt with the
-- new kind added to the allowlist (same copy-forward pattern as 002/003/010).
-- No new column and no data backfill: existing rows are copied as-is, and
-- `settings.active_llm_provider_id`'s FK follows the table rename unchanged.

CREATE TABLE llm_providers_new (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('anthropic', 'openai', 'ollama', 'ollama-cloud')),
  label             TEXT NOT NULL,
  model             TEXT NOT NULL,
  base_url          TEXT,
  encrypted_api_key BLOB,
  created_at        TEXT NOT NULL
);

INSERT INTO llm_providers_new
  (id, kind, label, model, base_url, encrypted_api_key, created_at)
SELECT id, kind, label, model, base_url, encrypted_api_key, created_at
FROM llm_providers;

DROP TABLE llm_providers;
ALTER TABLE llm_providers_new RENAME TO llm_providers;
