import type { Database as DatabaseType } from 'better-sqlite3';
import { NotFoundError, type SiteKind } from '@vina/shared';

export interface SiteRow {
  id: string;
  display_name: string;
  kind: SiteKind;
  enabled: boolean;
  session_path: string | null;
  session_valid_at: string | null;
  last_search_at: string | null;
}

interface RawSiteRow {
  id: string;
  display_name: string;
  kind: SiteKind;
  enabled: number;
  session_path: string | null;
  session_valid_at: string | null;
  last_search_at: string | null;
}

function rowToSite(row: RawSiteRow): SiteRow {
  return { ...row, enabled: row.enabled === 1 };
}

export function listSites(db: DatabaseType): SiteRow[] {
  const rows = db.prepare(`SELECT * FROM sites ORDER BY id ASC`).all() as RawSiteRow[];
  return rows.map(rowToSite);
}

export function findSiteById(db: DatabaseType, id: string): SiteRow | null {
  const row = db.prepare(`SELECT * FROM sites WHERE id = ?`).get(id) as RawSiteRow | undefined;
  return row ? rowToSite(row) : null;
}

export function updateSiteEnabled(db: DatabaseType, id: string, enabled: boolean): SiteRow {
  const result = db.prepare(`UPDATE sites SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
  if (result.changes === 0) throw new NotFoundError(`Site ${id} not found`);
  return findSiteById(db, id)!;
}

export function updateSiteSession(
  db: DatabaseType,
  id: string,
  patch: {
    session_path?: string | null;
    session_valid_at?: string | null;
    last_search_at?: string | null;
  },
): SiteRow {
  const current = findSiteById(db, id);
  if (!current) throw new NotFoundError(`Site ${id} not found`);

  const next: SiteRow = {
    ...current,
    ...(patch.session_path !== undefined && { session_path: patch.session_path }),
    ...(patch.session_valid_at !== undefined && {
      session_valid_at: patch.session_valid_at,
    }),
    ...(patch.last_search_at !== undefined && {
      last_search_at: patch.last_search_at,
    }),
  };

  db.prepare(
    `UPDATE sites SET session_path = ?, session_valid_at = ?, last_search_at = ? WHERE id = ?`,
  ).run(next.session_path, next.session_valid_at, next.last_search_at, id);

  return next;
}
