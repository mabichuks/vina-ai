import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDbDirect } from '../../src/db/client.js';
import { migrate } from '../../src/db/migrate.js';

describe('migrate', () => {
  let tmpDir: string;
  let migrationsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-mig-'));
    migrationsDir = path.join(tmpDir, 'migrations');
    fs.mkdirSync(migrationsDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('applies SQL files in lexical order and records them', () => {
    fs.writeFileSync(path.join(migrationsDir, '001_first.sql'), `CREATE TABLE t1 (id INTEGER);`);
    fs.writeFileSync(path.join(migrationsDir, '002_second.sql'), `CREATE TABLE t2 (id INTEGER);`);

    const db = openDbDirect({ filename: ':memory:' });
    const result = migrate(db, { migrationsDir });

    expect(result.applied).toEqual(['001_first.sql', '002_second.sql']);
    expect(result.skipped).toEqual([]);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as { name: string }[];
    expect(tables.map((r) => r.name)).toEqual(['_migrations', 't1', 't2']);
    db.close();
  });

  it('is idempotent — running twice applies each migration once', () => {
    fs.writeFileSync(path.join(migrationsDir, '001_first.sql'), `CREATE TABLE t1 (id INTEGER);`);

    const db = openDbDirect({ filename: ':memory:' });
    const first = migrate(db, { migrationsDir });
    const second = migrate(db, { migrationsDir });

    expect(first.applied).toEqual(['001_first.sql']);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['001_first.sql']);
    db.close();
  });

  it('rolls back on failure, leaving DB in pre-migration state', () => {
    fs.writeFileSync(path.join(migrationsDir, '001_first.sql'), `CREATE TABLE t1 (id INTEGER);`);
    fs.writeFileSync(
      path.join(migrationsDir, '002_broken.sql'),
      `CREATE TABLE t2 (id INTEGER); THIS IS NOT VALID SQL;`,
    );

    const db = openDbDirect({ filename: ':memory:' });
    expect(() => migrate(db, { migrationsDir })).toThrow();

    // 001 should have been applied successfully (separate transaction).
    // 002 should have been rolled back — t2 must not exist.
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as { name: string }[];
    const names = tables.map((r) => r.name);
    expect(names).toContain('t1');
    expect(names).not.toContain('t2');

    // _migrations should record only 001.
    const migRecords = db.prepare(`SELECT id FROM _migrations`).all() as { id: string }[];
    expect(migRecords.map((r) => r.id)).toEqual(['001_first.sql']);
    db.close();
  });

  it('returns empty result when migrations dir does not exist', () => {
    const db = openDbDirect({ filename: ':memory:' });
    const result = migrate(db, { migrationsDir: path.join(tmpDir, 'absent') });
    expect(result).toEqual({ applied: [], skipped: [] });
    db.close();
  });
});
