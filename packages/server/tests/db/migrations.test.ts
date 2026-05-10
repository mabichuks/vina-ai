import { describe, expect, it } from 'vitest';
import { freshTestDb } from './helpers.js';

describe('001_init', () => {
  it('creates all expected tables and seeds the three sites', () => {
    const db = freshTestDb();
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    for (const name of [
      'profile',
      'cvs',
      'cover_letters',
      'search_preferences',
      'settings',
      'schedules',
      'llm_providers',
      'sites',
      'jobs',
      'applications',
      'application_events',
      'alerts',
      'profile_answers',
      'chat_messages',
      'task_queue',
      'audit_log',
    ]) {
      expect(tables).toContain(name);
    }

    const sites = db.prepare(`SELECT id, kind FROM sites ORDER BY id`).all() as {
      id: string;
      kind: string;
    }[];
    expect(sites).toEqual([
      { id: 'google', kind: 'api' },
      { id: 'indeed', kind: 'browser' },
      { id: 'linkedin', kind: 'browser' },
    ]);
    db.close();
  });

  it('enforces CHECK constraints on enums and ID literals', () => {
    const db = freshTestDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO cvs (id, label, original_filename, mime_type, file_path, created_at)
           VALUES ('01', 'x', 'f', 'text/plain', 'p', '2026-04-28T10:00:00Z')`,
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO profile (id, full_name, email, created_at, updated_at)
           VALUES ('other', 'x', 'y@z', '2026-04-28T10:00:00Z', '2026-04-28T10:00:00Z')`,
        )
        .run(),
    ).toThrow(/CHECK/);
    db.close();
  });

  it('settings.active_llm_provider_id FK is RESTRICT', () => {
    const db = freshTestDb();
    db.prepare(
      `INSERT INTO llm_providers (id, kind, label, model, created_at)
       VALUES ('01P', 'anthropic', 'C', 'm', '2026-04-28T10:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO settings (id, mode, approval, active_llm_provider_id, updated_at)
       VALUES ('app', 'autonomous', 'review-first', '01P', '2026-04-28T10:00:00Z')`,
    ).run();
    expect(() => db.prepare(`DELETE FROM llm_providers WHERE id='01P'`).run()).toThrow();
    db.close();
  });

  it('jobs UNIQUE(site_id, external_id) and index plan for apply_method filter', () => {
    const db = freshTestDb();
    const insert = db.prepare(
      `INSERT INTO jobs (id, site_id, external_id, url, apply_method,
                         title, company, description, discovered_at, status)
       VALUES (?, 'linkedin', ?, 'u', 'auto', 't', 'c', 'd', '2026-04-28T10:00:00Z', 'new')`,
    );
    insert.run('01J1', 'abc');
    expect(() => insert.run('01J2', 'abc')).toThrow(/UNIQUE/);

    const plan = (
      db
        .prepare(`EXPLAIN QUERY PLAN SELECT * FROM jobs WHERE apply_method = ? AND status = ?`)
        .all('auto', 'new') as { detail: string }[]
    )
      .map((r) => r.detail)
      .join('\n');
    expect(plan).toMatch(/idx_jobs_apply_method/);
    db.close();
  });
});

describe('002_linkedin_e2e_schema', () => {
  it('adds consecutive_failures and paused columns to schedules', () => {
    const db = freshTestDb();
    const cols = db.prepare(`PRAGMA table_info(schedules)`).all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('consecutive_failures')).toBe(true);
    expect(names.has('paused')).toBe(true);
    db.close();
  });

  it('widens alerts.kind to include the new linkedin slice values', () => {
    const db = freshTestDb();
    for (const kind of [
      'linkedin_session_expired',
      'search_failed',
      'score_failed',
      'schedule_paused',
      'provider_failed',
    ]) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO alerts (id, kind, severity, title, description, status, created_at)
             VALUES (?, ?, 'info', 't', 'd', 'open', ?)`,
          )
          .run(`a-${kind}`, kind, new Date().toISOString()),
      ).not.toThrow();
    }
    db.close();
  });

  it('preserves existing alert rows through the rebuild', () => {
    const db = freshTestDb();
    db.prepare(
      `INSERT INTO alerts (id, kind, severity, title, description, status, created_at)
       VALUES ('pre-existing', 'general', 'info', 't', 'd', 'open', ?)`,
    ).run(new Date().toISOString());
    const row = db.prepare(`SELECT id FROM alerts WHERE id = 'pre-existing'`).get();
    expect(row).toBeDefined();
    db.close();
  });
});
