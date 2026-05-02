import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '@vina/shared';

const log = createLogger('vault');

/*
 * AES-256-GCM secrets vault.
 *
 * Wire format for encrypted blobs (stored as a SQLite BLOB column):
 *   [ iv (12 bytes) | ciphertext (n bytes) | authTag (16 bytes) ]
 *
 * The master key is 32 random bytes, persisted in the OS keychain via
 * `keytar` when available, otherwise in `dataDir/.master.key` with mode
 * 0600. `initVault()` is idempotent — call it once at boot, then use the
 * encrypt/decrypt helpers freely.
 */

const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

const KEYCHAIN_SERVICE = 'vina';
const KEYCHAIN_ACCOUNT = 'master-key';
const MASTER_KEY_FILENAME = '.master.key';

// Filled by `initVault()`. Module-level so encrypt/decrypt don't have to take
// a key parameter on every call site.
let masterKey: Buffer | null = null;

interface KeytarLike {
  getPassword: (service: string, account: string) => Promise<string | null>;
  setPassword: (service: string, account: string, secret: string) => Promise<void>;
}

async function tryLoadKeytar(): Promise<KeytarLike | null> {
  // Explicit opt-out for users who don't trust the OS keychain or want a
  // single-file footprint. Tests use this to exercise the file-backed path.
  if (process.env['VINA_DISABLE_KEYTAR'] === '1') return null;
  // keytar is an *optional* native dep — install can fail on Linux boxes
  // without libsecret, headless CI, etc. Treat any import error as
  // "no keychain available" and fall through to the file-backed key.
  try {
    const mod = (await import('keytar')) as { default?: KeytarLike } & KeytarLike;
    return mod.default ?? mod;
  } catch (err) {
    log.warn({ err }, 'keytar not available; falling back to file-backed master key');
    return null;
  }
}

function readKeyFile(file: string): Buffer | null {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== KEY_BYTES) {
      throw new Error(`Master key file has wrong length: ${buf.length} (expected ${KEY_BYTES})`);
    }
    return buf;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function writeKeyFile(file: string, key: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, key.toString('base64'), { mode: 0o600 });
}

/**
 * Resolve the master key, creating one on first run. Tries the OS keychain
 * first; if unavailable, persists to `dataDir/.master.key` with mode 0600.
 *
 * Subsequent calls return the cached key without re-reading.
 */
export async function initVault(dataDir: string): Promise<Buffer> {
  if (masterKey) return masterKey;

  const keytar = await tryLoadKeytar();

  if (keytar) {
    const stored = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    if (stored) {
      const buf = Buffer.from(stored, 'base64');
      if (buf.length !== KEY_BYTES) {
        throw new Error(`Master key in keychain has wrong length: ${buf.length}`);
      }
      masterKey = buf;
      return buf;
    }
    const generated = randomBytes(KEY_BYTES);
    await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, generated.toString('base64'));
    log.info('generated new master key in OS keychain');
    masterKey = generated;
    return generated;
  }

  const file = path.join(dataDir, MASTER_KEY_FILENAME);
  const existing = readKeyFile(file);
  if (existing) {
    masterKey = existing;
    return existing;
  }

  const generated = randomBytes(KEY_BYTES);
  writeKeyFile(file, generated);
  log.info({ file }, 'generated new master key file (mode 0600)');
  masterKey = generated;
  return generated;
}

/** Test-only: reset the cached key so a subsequent `initVault` re-reads. */
export function _resetVaultForTests(): void {
  masterKey = null;
}

function requireKey(): Buffer {
  if (!masterKey) {
    throw new Error('Vault not initialised — call initVault(dataDir) at startup');
  }
  return masterKey;
}

export function encrypt(plaintext: string): Buffer {
  const key = requireKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv) as CipherGCM;
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]);
}

export function decrypt(blob: Buffer): string {
  const key = requireKey();
  if (blob.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new Error('Ciphertext too short to contain IV + auth tag');
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(blob.length - AUTH_TAG_BYTES);
  const ct = blob.subarray(IV_BYTES, blob.length - AUTH_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv) as DecipherGCM;
  decipher.setAuthTag(tag);
  // .final() throws on auth-tag mismatch — that's how tampering is caught.
  const out = Buffer.concat([decipher.update(ct), decipher.final()]);
  return out.toString('utf8');
}
