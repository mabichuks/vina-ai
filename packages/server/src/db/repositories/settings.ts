import type { Database as DatabaseType } from 'better-sqlite3';
import type { EasyApplyMode } from '@vina/shared';

/**
 * The DB-row shape for settings. The repo trades in *ciphertext* for the
 * SerpAPI key — the vault encrypts at the route layer before calling here
 * and decrypts on the way out.
 */
export interface SettingsRow {
  id: 'app';
  easy_apply_mode: EasyApplyMode;
  autonomous_apply_dry_run: boolean;
  apply_daily_cap: number;
  apply_min_interval_seconds: number;
  apply_listing_max_age_days: number;
  apply_consecutive_failure_limit: number;
  browser_headful: boolean;
  browser_stealth: boolean;
  paused: boolean;
  active_llm_provider_id: string | null;
  encrypted_serpapi_key: Buffer | null;
  updated_at: string;
}

interface RawSettingsRow {
  id: 'app';
  easy_apply_mode: EasyApplyMode;
  autonomous_apply_dry_run: number;
  apply_daily_cap: number;
  apply_min_interval_seconds: number;
  apply_listing_max_age_days: number;
  apply_consecutive_failure_limit: number;
  browser_headful: number;
  browser_stealth: number;
  paused: number;
  active_llm_provider_id: string | null;
  encrypted_serpapi_key: Buffer | null;
  updated_at: string;
}

function rowToSettings(row: RawSettingsRow): SettingsRow {
  return {
    id: 'app',
    easy_apply_mode: row.easy_apply_mode,
    autonomous_apply_dry_run: row.autonomous_apply_dry_run === 1,
    apply_daily_cap: row.apply_daily_cap,
    apply_min_interval_seconds: row.apply_min_interval_seconds,
    apply_listing_max_age_days: row.apply_listing_max_age_days,
    apply_consecutive_failure_limit: row.apply_consecutive_failure_limit,
    browser_headful: row.browser_headful === 1,
    browser_stealth: row.browser_stealth === 1,
    paused: row.paused === 1,
    active_llm_provider_id: row.active_llm_provider_id,
    encrypted_serpapi_key: row.encrypted_serpapi_key,
    updated_at: row.updated_at,
  };
}

// Migration 007 seeds the 'app' row via INSERT OR IGNORE, so the lazy init
// fallback below is only needed if getOrInitSettings is called before
// migrations run (e.g. in tests that bootstrap manually). The defaults here
// must match the migration's column defaults.
const DEFAULTS: Omit<SettingsRow, 'updated_at'> = {
  id: 'app',
  easy_apply_mode: 'manual',
  autonomous_apply_dry_run: false,
  apply_daily_cap: 10,
  apply_min_interval_seconds: 300,
  apply_listing_max_age_days: 14,
  apply_consecutive_failure_limit: 5,
  browser_headful: false,
  browser_stealth: false,
  paused: false,
  active_llm_provider_id: null,
  encrypted_serpapi_key: null,
};

export function getOrInitSettings(db: DatabaseType): SettingsRow {
  const row = db.prepare(`SELECT * FROM settings WHERE id = 'app'`).get() as
    | RawSettingsRow
    | undefined;
  if (row) return rowToSettings(row);

  // The migration seeds the row, but if somehow the row is missing, insert it.
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO settings
       (id, easy_apply_mode, autonomous_apply_dry_run, apply_daily_cap,
        apply_min_interval_seconds, apply_listing_max_age_days,
        apply_consecutive_failure_limit,
        browser_headful, browser_stealth, paused,
        active_llm_provider_id, encrypted_serpapi_key, updated_at)
     VALUES ('app', @easy_apply_mode, @autonomous_apply_dry_run, @apply_daily_cap,
             @apply_min_interval_seconds, @apply_listing_max_age_days,
             @apply_consecutive_failure_limit,
             @browser_headful, @browser_stealth, @paused,
             @active_llm_provider_id, @encrypted_serpapi_key, @updated_at)`,
  ).run({
    easy_apply_mode: DEFAULTS.easy_apply_mode,
    autonomous_apply_dry_run: DEFAULTS.autonomous_apply_dry_run ? 1 : 0,
    apply_daily_cap: DEFAULTS.apply_daily_cap,
    apply_min_interval_seconds: DEFAULTS.apply_min_interval_seconds,
    apply_listing_max_age_days: DEFAULTS.apply_listing_max_age_days,
    apply_consecutive_failure_limit: DEFAULTS.apply_consecutive_failure_limit,
    browser_headful: DEFAULTS.browser_headful ? 1 : 0,
    browser_stealth: DEFAULTS.browser_stealth ? 1 : 0,
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
  easy_apply_mode?: EasyApplyMode;
  autonomous_apply_dry_run?: boolean;
  apply_daily_cap?: number;
  apply_min_interval_seconds?: number;
  apply_listing_max_age_days?: number;
  apply_consecutive_failure_limit?: number;
  browser_headful?: boolean;
  browser_stealth?: boolean;
  paused?: boolean;
  active_llm_provider_id?: string | null;
  encrypted_serpapi_key?: Buffer | null;
}

export function updateSettings(db: DatabaseType, patch: SettingsUpdatePatch): SettingsRow {
  const current = getOrInitSettings(db);

  const next: SettingsRow = {
    ...current,
    ...(patch.easy_apply_mode !== undefined && { easy_apply_mode: patch.easy_apply_mode }),
    ...(patch.autonomous_apply_dry_run !== undefined && {
      autonomous_apply_dry_run: patch.autonomous_apply_dry_run,
    }),
    ...(patch.apply_daily_cap !== undefined && { apply_daily_cap: patch.apply_daily_cap }),
    ...(patch.apply_min_interval_seconds !== undefined && {
      apply_min_interval_seconds: patch.apply_min_interval_seconds,
    }),
    ...(patch.apply_listing_max_age_days !== undefined && {
      apply_listing_max_age_days: patch.apply_listing_max_age_days,
    }),
    ...(patch.apply_consecutive_failure_limit !== undefined && {
      apply_consecutive_failure_limit: patch.apply_consecutive_failure_limit,
    }),
    ...(patch.browser_headful !== undefined && {
      browser_headful: patch.browser_headful,
    }),
    ...(patch.browser_stealth !== undefined && {
      browser_stealth: patch.browser_stealth,
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
       easy_apply_mode=@easy_apply_mode,
       autonomous_apply_dry_run=@autonomous_apply_dry_run,
       apply_daily_cap=@apply_daily_cap,
       apply_min_interval_seconds=@apply_min_interval_seconds,
       apply_listing_max_age_days=@apply_listing_max_age_days,
       apply_consecutive_failure_limit=@apply_consecutive_failure_limit,
       browser_headful=@browser_headful, browser_stealth=@browser_stealth,
       paused=@paused,
       active_llm_provider_id=@active_llm_provider_id,
       encrypted_serpapi_key=@encrypted_serpapi_key,
       updated_at=@updated_at
     WHERE id='app'`,
  ).run({
    easy_apply_mode: next.easy_apply_mode,
    autonomous_apply_dry_run: next.autonomous_apply_dry_run ? 1 : 0,
    apply_daily_cap: next.apply_daily_cap,
    apply_min_interval_seconds: next.apply_min_interval_seconds,
    apply_listing_max_age_days: next.apply_listing_max_age_days,
    apply_consecutive_failure_limit: next.apply_consecutive_failure_limit,
    browser_headful: next.browser_headful ? 1 : 0,
    browser_stealth: next.browser_stealth ? 1 : 0,
    paused: next.paused ? 1 : 0,
    active_llm_provider_id: next.active_llm_provider_id,
    encrypted_serpapi_key: next.encrypted_serpapi_key,
    updated_at: next.updated_at,
  });

  return next;
}
