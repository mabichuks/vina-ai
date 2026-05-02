import type { Database as DatabaseType } from 'better-sqlite3';
import {
  getOrInitSettings,
  updateSettings,
  type SettingsRow,
} from '../db/repositories/settings.js';
import { decrypt, encrypt } from '../secrets/vault.js';

/**
 * Service layer for the settings row's encrypted columns. Mirrors the LLM
 * service: routes hand plaintext in/out, the vault handles encryption, the
 * repo only ever sees ciphertext `Buffer`s.
 */

export function setSerpApiKey(db: DatabaseType, plaintext: string): SettingsRow {
  return updateSettings(db, { encrypted_serpapi_key: encrypt(plaintext) });
}

export function clearSerpApiKey(db: DatabaseType): SettingsRow {
  return updateSettings(db, { encrypted_serpapi_key: null });
}

export function getDecryptedSerpApiKey(db: DatabaseType): string | null {
  const settings = getOrInitSettings(db);
  if (!settings.encrypted_serpapi_key) return null;
  return decrypt(settings.encrypted_serpapi_key);
}

export function hasSerpApiKey(db: DatabaseType): boolean {
  return getOrInitSettings(db).encrypted_serpapi_key !== null;
}
