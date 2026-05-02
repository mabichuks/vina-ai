import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { freshTestDb } from '../db/helpers.js';
import { _resetVaultForTests, initVault } from '../../src/secrets/vault.js';
import {
  clearSerpApiKey,
  getDecryptedSerpApiKey,
  hasSerpApiKey,
  setSerpApiKey,
} from '../../src/services/settings-service.js';

let tmpDir: string;
let db: DatabaseType;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-settings-'));
  process.env['VINA_DISABLE_KEYTAR'] = '1';
  _resetVaultForTests();
  await initVault(tmpDir);
  db = freshTestDb();
});

afterEach(() => {
  delete process.env['VINA_DISABLE_KEYTAR'];
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('settings-service SerpAPI key', () => {
  it('round-trips plaintext, never leaks it to the row', () => {
    const plaintext = 'serp-key-12345';
    setSerpApiKey(db, plaintext);

    const raw = db.prepare(`SELECT encrypted_serpapi_key FROM settings WHERE id='app'`).get() as {
      encrypted_serpapi_key: Buffer;
    };
    expect(raw.encrypted_serpapi_key.toString('utf8')).not.toContain(plaintext);

    expect(getDecryptedSerpApiKey(db)).toBe(plaintext);
    expect(hasSerpApiKey(db)).toBe(true);
  });

  it('clear removes the key; getter returns null afterwards', () => {
    setSerpApiKey(db, 'temp');
    clearSerpApiKey(db);
    expect(getDecryptedSerpApiKey(db)).toBeNull();
    expect(hasSerpApiKey(db)).toBe(false);
  });
});
