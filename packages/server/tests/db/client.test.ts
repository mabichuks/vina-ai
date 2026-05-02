import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../src/db/client.js';

describe('SQLite client singleton', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-db-'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the WAL file on first write and enables foreign keys', () => {
    const filename = path.join(tmpDir, 'vina.db');
    const db = getDb({ filename });
    db.exec('CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1);');

    expect(fs.existsSync(`${filename}-wal`)).toBe(true);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('returns the same instance on repeat calls and refuses a different filename', () => {
    const a = getDb({ filename: path.join(tmpDir, 'one.db') });
    expect(getDb()).toBe(a);
    expect(() => getDb({ filename: path.join(tmpDir, 'two.db') })).toThrow();
  });

  it('closeDb releases the file handle so the file becomes deletable', () => {
    const filename = path.join(tmpDir, 'vina.db');
    getDb({ filename }).exec('CREATE TABLE t (a INTEGER);');
    closeDb();
    fs.unlinkSync(filename);
    expect(fs.existsSync(filename)).toBe(false);
  });
});
