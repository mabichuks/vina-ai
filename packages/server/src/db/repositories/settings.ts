import type { Database as DatabaseType } from 'better-sqlite3';
import type { ApprovalSetting, OperatingMode } from '@vina/shared';

/**
 * The DB-row shape for settings. The repo trades in *ciphertext* for the
 * SerpAPI key — the vault encrypts at the route layer before calling here
 * and decrypts on the way out.
 */
export interface SettingsRow {
  id: 'app';
  mode: OperatingMode;
  approval: ApprovalSetting;
  browser_headful: boolean;
  paused: boolean;
  active_llm_provider_id: string | null;
  encrypted_serpapi_key: Buffer | null;
  updated_at: string;
}

interface RawSettingsRow {
  id: 'app';
  mode: OperatingMode;
  approval: ApprovalSetting;
  browser_headful: number;
  paused: number;
  active_llm_provider_id: string | null;
  encrypted_serpapi_key: Buffer | null;
  updated_at: string;
}

function rowToSettings(row: RawSettingsRow): SettingsRow {
  return {
    id: 'app',
    mode: row.mode,
    approval: row.approval,
    browser_headful: row.browser_headful === 1,
    paused: row.paused === 1,
    active_llm_provider_id: row.active_llm_provider_id,
    encrypted_serpapi_key: row.encrypted_serpapi_key,
    updated_at: row.updated_at,
  };
}

const DEFAULTS: Omit<SettingsRow, 'updated_at'> = {
  id: 'app',
  mode: 'supervised',
  approval: 'review-first',
  browser_headful: false,
  paused: false,
  active_llm_provider_id: null,
  encrypted_serpapi_key: null,
};

export function getOrInitSettings(db: DatabaseType): SettingsRow {
  const row = db.prepare(`SELECT * FROM settings WHERE id = 'app'`).get() as
    | RawSettingsRow
    | undefined;
  if (row) return rowToSettings(row);

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO settings
       (id, mode, approval, browser_headful, paused,
        active_llm_provider_id, encrypted_serpapi_key, updated_at)
     VALUES ('app', @mode, @approval, @browser_headful, @paused,
             @active_llm_provider_id, @encrypted_serpapi_key, @updated_at)`,
  ).run({
    mode: DEFAULTS.mode,
    approval: DEFAULTS.approval,
    browser_headful: DEFAULTS.browser_headful ? 1 : 0,
    paused: DEFAULTS.paused ? 1 : 0,
    active_llm_provider_id: DEFAULTS.active_llm_provider_id,
    encrypted_serpapi_key: DEFAULTS.encrypted_serpapi_key,
    updated_at: now,
  });

  return { ...DEFAULTS, updated_at: now };
}

/**
 * Partial update — only provided fields are written. `encrypted_serpapi_key`
 * may be passed as `null` to explicitly clear it (distinguished from
 * `undefined` which means "leave unchanged").
 */
export interface SettingsUpdatePatch {
  mode?: OperatingMode;
  approval?: ApprovalSetting;
  browser_headful?: boolean;
  paused?: boolean;
  active_llm_provider_id?: string | null;
  encrypted_serpapi_key?: Buffer | null;
}

export function updateSettings(db: DatabaseType, patch: SettingsUpdatePatch): SettingsRow {
  const current = getOrInitSettings(db);

  const next: SettingsRow = {
    ...current,
    ...(patch.mode !== undefined && { mode: patch.mode }),
    ...(patch.approval !== undefined && { approval: patch.approval }),
    ...(patch.browser_headful !== undefined && {
      browser_headful: patch.browser_headful,
    }),
    ...(patch.paused !== undefined && { paused: patch.paused }),
    ...(patch.active_llm_provider_id !== undefined && {
      active_llm_provider_id: patch.active_llm_provider_id,
    }),
    ...(patch.encrypted_serpapi_key !== undefined && {
      encrypted_serpapi_key: patch.encrypted_serpapi_key,
    }),
    updated_at: new Date().toISOString(),
  };

  db.prepare(
    `UPDATE settings SET
       mode=@mode, approval=@approval,
       browser_headful=@browser_headful, paused=@paused,
       active_llm_provider_id=@active_llm_provider_id,
       encrypted_serpapi_key=@encrypted_serpapi_key,
       updated_at=@updated_at
     WHERE id='app'`,
  ).run({
    mode: next.mode,
    approval: next.approval,
    browser_headful: next.browser_headful ? 1 : 0,
    paused: next.paused ? 1 : 0,
    active_llm_provider_id: next.active_llm_provider_id,
    encrypted_serpapi_key: next.encrypted_serpapi_key,
    updated_at: next.updated_at,
  });

  return next;
}
