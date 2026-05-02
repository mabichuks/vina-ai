import type { Database as DatabaseType } from 'better-sqlite3';
import { NotFoundError, newId, type LlmProviderKind } from '@vina/shared';

/**
 * DB-row shape. The repo trades in *ciphertext* for the API key — the vault
 * encrypts on the way in and decrypts on the way out at the call site.
 */
export interface LlmProviderRow {
  id: string;
  kind: LlmProviderKind;
  label: string;
  model: string;
  base_url: string | null;
  encrypted_api_key: Buffer | null;
  created_at: string;
}

export function listLlmProviders(db: DatabaseType): LlmProviderRow[] {
  return db
    .prepare(`SELECT * FROM llm_providers ORDER BY created_at ASC`)
    .all() as LlmProviderRow[];
}

export function findLlmProviderById(db: DatabaseType, id: string): LlmProviderRow | null {
  const row = db.prepare(`SELECT * FROM llm_providers WHERE id = ?`).get(id) as
    | LlmProviderRow
    | undefined;
  return row ?? null;
}

export interface LlmProviderInsertInput {
  kind: LlmProviderKind;
  label: string;
  model: string;
  base_url?: string | null;
  encrypted_api_key?: Buffer | null;
}

export function insertLlmProvider(db: DatabaseType, input: LlmProviderInsertInput): LlmProviderRow {
  const id = newId();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO llm_providers
       (id, kind, label, model, base_url, encrypted_api_key, created_at)
     VALUES (@id, @kind, @label, @model, @base_url, @encrypted_api_key, @created_at)`,
  ).run({
    id,
    kind: input.kind,
    label: input.label,
    model: input.model,
    base_url: input.base_url ?? null,
    encrypted_api_key: input.encrypted_api_key ?? null,
    created_at: now,
  });

  const row = findLlmProviderById(db, id);
  if (!row) throw new Error('insertLlmProvider: row missing immediately after insert');
  return row;
}

export interface LlmProviderUpdatePatch {
  label?: string;
  model?: string;
  base_url?: string | null;
  encrypted_api_key?: Buffer | null;
}

export function updateLlmProvider(
  db: DatabaseType,
  id: string,
  patch: LlmProviderUpdatePatch,
): LlmProviderRow {
  const current = findLlmProviderById(db, id);
  if (!current) throw new NotFoundError(`LLM provider ${id} not found`);

  const next: LlmProviderRow = {
    ...current,
    ...(patch.label !== undefined && { label: patch.label }),
    ...(patch.model !== undefined && { model: patch.model }),
    ...(patch.base_url !== undefined && { base_url: patch.base_url }),
    ...(patch.encrypted_api_key !== undefined && {
      encrypted_api_key: patch.encrypted_api_key,
    }),
  };

  db.prepare(
    `UPDATE llm_providers SET label=?, model=?, base_url=?, encrypted_api_key=? WHERE id=?`,
  ).run(next.label, next.model, next.base_url, next.encrypted_api_key, id);

  return next;
}

/**
 * Delete a provider. Throws if `settings.active_llm_provider_id` references
 * it (FK is RESTRICT, so the underlying error is a SqliteError; we surface
 * the same NotFoundError shape callers can recover from).
 */
export function deleteLlmProvider(db: DatabaseType, id: string): void {
  const exists = findLlmProviderById(db, id);
  if (!exists) throw new NotFoundError(`LLM provider ${id} not found`);
  db.prepare(`DELETE FROM llm_providers WHERE id = ?`).run(id);
}
