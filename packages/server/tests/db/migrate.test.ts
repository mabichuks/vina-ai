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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('applies SQL files in lexical order, records them, and is idempotent', () => {
    fs.writeFileSync(path.join(migrationsDir, '001.sql'), `CREATE TABLE t1 (id INTEGER);`);
    fs.writeFileSync(path.join(migrationsDir, '002.sql'), `CREATE TABLE t2 (id INTEGER);`);

    const db = openDbDirect({ filename: ':memory:' });
    expect(migrate(db, { migrationsDir }).applied).toEqual(['001.sql', '002.sql']);
    expect(migrate(db, { migrationsDir }).applied).toEqual([]); // idempotent

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as { name: string }[];
    expect(tables.map((r) => r.name)).toEqual(['_migrations', 't1', 't2']);
    db.close();
  });

  it('rolls back on failure, leaving the DB in its pre-migration state', () => {
    fs.writeFileSync(path.join(migrationsDir, '001.sql'), `CREATE TABLE t1 (id INTEGER);`);
    fs.writeFileSync(
      path.join(migrationsDir, '002.sql'),
      `CREATE TABLE t2 (id INTEGER); THIS IS NOT VALID SQL;`,
    );

    const db = openDbDirect({ filename: ':memory:' });
    expect(() => migrate(db, { migrationsDir })).toThrow();

    const names = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(names).toContain('t1');
    expect(names).not.toContain('t2');
    expect(
      (db.prepare(`SELECT id FROM _migrations`).all() as { id: string }[]).map((r) => r.id),
    ).toEqual(['001.sql']);
    db.close();
  });
});
