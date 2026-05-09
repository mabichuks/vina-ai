import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { openDbDirect } from '../../src/db/client.js';
import { migrate } from '../../src/db/migrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '..', '..', 'migrations');

function freshDb(): DatabaseType {
  const db = openDbDirect({ filename: ':memory:' });
  migrate(db, { migrationsDir });
  return db;
}

describe('001_init: profile / cvs / cover letters', () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => {
    db.close();
  });

  it('creates the profile, cvs and cover_letters tables', () => {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {
      name: string;
    }[];
    const names = tables.map((r) => r.name);
    expect(names).toContain('profile');
    expect(names).toContain('cvs');
    expect(names).toContain('cover_letters');
  });

  it('rejects invalid CV mime_type', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO cvs (id, label, original_filename, mime_type, file_path, created_at)
           VALUES ('01CV', 'x', 'cv.txt', 'text/plain', 'p', '2026-04-28T10:00:00Z')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it('rejects profile with id != "me"', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO profile (id, full_name, email, created_at, updated_at)
           VALUES ('other', 'x', 'x@y.com', '2026-04-28T10:00:00Z', '2026-04-28T10:00:00Z')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});

describe('001_init: settings / llm_providers FK', () => {
  let db: DatabaseType;
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => {
    db.close();
  });

  it('foreign key from settings.active_llm_provider_id to llm_providers.id is enforced', () => {
    db.prepare(
      `INSERT INTO llm_providers (id, kind, label, model, created_at)
       VALUES ('01PROV', 'anthropic', 'Claude', 'claude-opus-4-7', '2026-04-28T10:00:00Z')`,
    ).run();

    db.prepare(
      `INSERT INTO settings (id, mode, approval, active_llm_provider_id, updated_at)
       VALUES ('app', 'autonomous', 'review-first', '01PROV', '2026-04-28T10:00:00Z')`,
    ).run();

    // Deleting the provider while settings references it must fail (RESTRICT).
    expect(() => db.prepare(`DELETE FROM llm_providers WHERE id = '01PROV'`).run()).toThrow();

    // After clearing settings.active_llm_provider_id, the delete should succeed.
    db.prepare(`UPDATE settings SET active_llm_provider_id = NULL WHERE id = 'app'`).run();
    db.prepare(`DELETE FROM llm_providers WHERE id = '01PROV'`).run();
  });

  it('settings.id is constrained to "app"', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO settings (id, mode, approval, updated_at)
           VALUES ('global', 'autonomous', 'review-first', '2026-04-28T10:00:00Z')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});

describe('001_init: sites table seeds', () => {
  it('seeds exactly three rows with the right kinds', () => {
    const db = freshDb();
    const rows = db.prepare(`SELECT id, kind FROM sites ORDER BY id`).all() as {
      id: string;
      kind: string;
    }[];
    expect(rows).toEqual([
      { id: 'google', kind: 'api' },
      { id: 'indeed', kind: 'browser' },
      { id: 'linkedin', kind: 'browser' },
    ]);
    db.close();
  });

  it('re-running migrations does not duplicate seeds', () => {
    const db = openDbDirect({ filename: ':memory:' });
    migrate(db, { migrationsDir });
    migrate(db, { migrationsDir });
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM sites`).get() as { n: number }).n;
    expect(count).toBe(3);
    db.close();
  });
});

describe('001_init: jobs / applications', () => {
  let db: DatabaseType;
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => {
    db.close();
  });

  function insertJob(
    externalId: string,
    applyMethod: 'auto' | 'manual' = 'auto',
    externalApplyUrl: string | null = null,
  ) {
    db.prepare(
      `INSERT INTO jobs (id, site_id, external_id, url, external_apply_url, apply_method,
                         title, company, description, discovered_at, status)
       VALUES (?, 'linkedin', ?, 'https://x', ?, ?, 'T', 'C', 'D', '2026-04-28T10:00:00Z', 'new')`,
    ).run(`01JOB-${externalId}`, externalId, externalApplyUrl, applyMethod);
  }

  it('UNIQUE(site_id, external_id) prevents duplicate jobs', () => {
    insertJob('abc');
    expect(() => insertJob('abc')).toThrow(/UNIQUE/);
  });

  it('apply_method=auto with NULL external_apply_url is allowed', () => {
    expect(() => insertJob('abc', 'auto', null)).not.toThrow();
  });

  it('rejects unknown job status', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO jobs (id, site_id, external_id, url, apply_method,
                             title, company, description, discovered_at, status)
           VALUES ('01J', 'linkedin', 'x', 'u', 'auto', 't', 'c', 'd', '2026-04-28T10:00:00Z', 'wat')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});

describe('001_init: alerts / events / queue', () => {
  let db: DatabaseType;
  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => {
    db.close();
  });

  function insertAlert(kind: string) {
    db.prepare(
      `INSERT INTO alerts (id, kind, severity, title, description, status, created_at)
       VALUES (?, ?, 'action_required', 't', 'd', 'open', '2026-04-28T10:00:00Z')`,
    ).run(`01A-${kind}`, kind);
  }

  it('accepts ready_for_manual_apply and captcha alert kinds', () => {
    expect(() => insertAlert('ready_for_manual_apply')).not.toThrow();
    expect(() => insertAlert('captcha')).not.toThrow();
  });

  it('rejects unknown alert kind', () => {
    expect(() => insertAlert('rocket_launched')).toThrow(/CHECK/);
  });
});

describe('001_init: indexes are used for apply_method filters', () => {
  it('EXPLAIN QUERY PLAN shows an index on (apply_method, status)', () => {
    const db = freshDb();
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN SELECT * FROM jobs WHERE apply_method = ? AND status = ?`)
      .all('auto', 'new') as { detail: string }[];
    const detail = plan.map((r) => r.detail).join('\n');
    expect(detail).toMatch(/idx_jobs_apply_method/);
    db.close();
  });
});
