import type { Database as DatabaseType } from 'better-sqlite3';
import { newId } from '@vina/shared';

export interface ProfileAnswer {
  id: string;
  key: string;
  label: string;
  value: string;
  created_at: string;
  updated_at: string;
}

export function findAnswer(db: DatabaseType, key: string): ProfileAnswer | null {
  const row = db.prepare(`SELECT * FROM profile_answers WHERE key = ?`).get(key) as
    | ProfileAnswer
    | undefined;
  return row ?? null;
}

export function listAnswers(db: DatabaseType): ProfileAnswer[] {
  return db.prepare(`SELECT * FROM profile_answers ORDER BY key ASC`).all() as ProfileAnswer[];
}

export function upsertAnswer(
  db: DatabaseType,
  key: string,
  label: string,
  value: string,
): ProfileAnswer {
  const existing = findAnswer(db, key);
  const now = new Date().toISOString();
  if (existing) {
    db.prepare(`UPDATE profile_answers SET label = ?, value = ?, updated_at = ? WHERE key = ?`).run(
      label,
      value,
      now,
      key,
    );
    return { ...existing, label, value, updated_at: now };
  }
  const id = newId();
  db.prepare(
    `INSERT INTO profile_answers (id, key, label, value, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, key, label, value, now, now);
  return { id, key, label, value, created_at: now, updated_at: now };
}

export function deleteAnswer(db: DatabaseType, key: string): boolean {
  const result = db.prepare(`DELETE FROM profile_answers WHERE key = ?`).run(key);
  return result.changes > 0;
}
