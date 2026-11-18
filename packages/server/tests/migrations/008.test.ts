import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '..', '..', 'migrations');

function freshDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  migrate(db, { migrationsDir });
  return db;
}

describe('migration 008', () => {
  it('adds a nullable chat_session_id column to settings', () => {
    const db = freshDb();
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('chat_session_id');
    db.close();
  });

  it('defaults chat_session_id to NULL on the seeded app row', () => {
    const db = freshDb();
    const row = db.prepare(`SELECT chat_session_id FROM settings WHERE id = 'app'`).get() as
      | { chat_session_id: string | null }
      | undefined;
    expect(row?.chat_session_id).toBeNull();
    db.close();
  });

  it('persists and round-trips a chat session id', () => {
    const db = freshDb();
    db.prepare(`UPDATE settings SET chat_session_id = ? WHERE id = 'app'`).run('ses_abc');
    const row = db.prepare(`SELECT chat_session_id FROM settings WHERE id = 'app'`).get() as {
      chat_session_id: string | null;
    };
    expect(row.chat_session_id).toBe('ses_abc');
    db.close();
  });
});
