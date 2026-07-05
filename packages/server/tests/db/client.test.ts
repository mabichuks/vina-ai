import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, openDbDirect } from '../../src/db/client.js';

describe('SQLite client singleton', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-db-'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('creates the DB file and WAL companion files on first write', () => {
    const filename = path.join(tmpDir, 'vina.db');
    const db = getDb({ filename });
    db.exec('CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1);');

    expect(fs.existsSync(filename)).toBe(true);
    expect(fs.existsSync(`${filename}-wal`)).toBe(true);
  });

  it('enables foreign keys', () => {
    const filename = path.join(tmpDir, 'vina.db');
    const db = getDb({ filename });
    const row = db.pragma('foreign_keys', { simple: true });
    expect(row).toBe(1);
  });

  it('returns the same instance on subsequent calls', () => {
    const filename = path.join(tmpDir, 'vina.db');
    const a = getDb({ filename });
    const b = getDb();
    expect(a).toBe(b);
  });

  it('throws if reopened with a different filename', () => {
    getDb({ filename: path.join(tmpDir, 'one.db') });
    expect(() => getDb({ filename: path.join(tmpDir, 'two.db') })).toThrow();
  });

  it('closeDb releases the file handle and the file becomes deletable', () => {
    const filename = path.join(tmpDir, 'vina.db');
    const db = getDb({ filename });
    db.exec('CREATE TABLE t (a INTEGER);');
    closeDb();
    // After close, deleting the file must succeed without an EBUSY-equivalent.
    fs.unlinkSync(filename);
    expect(fs.existsSync(filename)).toBe(false);
  });

  it('openDbDirect bypasses the singleton', () => {
    const a = openDbDirect({ filename: ':memory:' });
    const b = openDbDirect({ filename: ':memory:' });
    expect(a).not.toBe(b);
    a.close();
    b.close();
  });
});
