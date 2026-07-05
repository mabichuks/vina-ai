import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetVaultForTests, decrypt, encrypt, initVault } from '../../src/secrets/vault.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-vault-'));
  process.env['VINA_DISABLE_KEYTAR'] = '1';
  _resetVaultForTests();
});

afterEach(() => {
  delete process.env['VINA_DISABLE_KEYTAR'];
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('vault', () => {
  it('round-trips plaintext through encrypt/decrypt', async () => {
    await initVault(tmpDir);
    expect(decrypt(encrypt('hello world'))).toBe('hello world');

    const longPlaintext = 'sk-ant-' + 'x'.repeat(200);
    expect(decrypt(encrypt(longPlaintext))).toBe(longPlaintext);
  });

  it('rejects tampered ciphertext via the GCM auth tag', async () => {
    await initVault(tmpDir);
    const blob = encrypt('secret');
    const tampered = Buffer.from(blob);
    // Flip a byte in the ciphertext region (after the 12-byte IV, before the
    // last 16 bytes of auth tag).
    tampered[15] ^= 0xff;
    expect(() => decrypt(tampered)).toThrow();
  });

  it('encrypt/decrypt before initVault throws a clear error', () => {
    expect(() => encrypt('x')).toThrow(/Vault not initialised/);
    expect(() => decrypt(Buffer.alloc(40))).toThrow(/Vault not initialised/);
  });

  it('decrypt rejects a buffer too short to hold IV + tag', async () => {
    await initVault(tmpDir);
    expect(() => decrypt(Buffer.alloc(10))).toThrow(/too short/i);
  });

  it('persists the master key across initVault calls (file-backed)', async () => {
    const key1 = await initVault(tmpDir);
    const blob = encrypt('persist me');

    _resetVaultForTests();
    const key2 = await initVault(tmpDir);
    expect(Buffer.compare(key1, key2)).toBe(0);
    expect(decrypt(blob)).toBe('persist me');

    expect(fs.existsSync(path.join(tmpDir, '.master.key'))).toBe(true);
    const stat = fs.statSync(path.join(tmpDir, '.master.key'));
    // mode 0600 → owner rw, no one else (low 9 bits)
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
