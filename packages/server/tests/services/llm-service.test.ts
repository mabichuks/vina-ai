import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { freshTestDb } from '../db/helpers.js';
import { _resetVaultForTests, initVault } from '../../src/secrets/vault.js';
import {
  createProvider,
  getDecryptedApiKey,
  updateProvider,
  validateProvider,
} from '../../src/services/llm-service.js';

let tmpDir: string;
let db: DatabaseType;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-llm-'));
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

describe('llm-service', () => {
  it('encrypts on create and the DB row never contains plaintext', () => {
    const plaintext = 'sk-ant-test-1234567890';
    const provider = createProvider(db, {
      kind: 'anthropic',
      label: 'Claude',
      model: 'claude-opus-4-7',
      api_key: plaintext,
    });

    const raw = db
      .prepare(`SELECT encrypted_api_key FROM llm_providers WHERE id = ?`)
      .get(provider.id) as { encrypted_api_key: Buffer };
    expect(raw.encrypted_api_key).toBeInstanceOf(Buffer);
    expect(raw.encrypted_api_key.toString('utf8')).not.toContain(plaintext);
  });

  it('getDecryptedApiKey returns the original plaintext', () => {
    const plaintext = 'sk-ant-test-9876';
    const { id } = createProvider(db, {
      kind: 'anthropic',
      label: 'Claude',
      model: 'claude-opus-4-7',
      api_key: plaintext,
    });
    expect(getDecryptedApiKey(db, id)).toBe(plaintext);
  });

  it('returns null for providers without a key (e.g. Ollama)', () => {
    const { id } = createProvider(db, {
      kind: 'ollama',
      label: 'Local',
      model: 'llama3.1:70b',
      base_url: 'http://localhost:11434',
    });
    expect(getDecryptedApiKey(db, id)).toBeNull();
  });

  it('updateProvider re-encrypts a new key, leaves untouched fields alone', () => {
    const { id } = createProvider(db, {
      kind: 'openai',
      label: 'GPT',
      model: 'gpt-5',
      api_key: 'first',
    });
    updateProvider(db, id, { api_key: 'second' });
    expect(getDecryptedApiKey(db, id)).toBe('second');

    updateProvider(db, id, { label: 'GPT (renamed)' });
    expect(getDecryptedApiKey(db, id)).toBe('second');

    updateProvider(db, id, { api_key: null });
    expect(getDecryptedApiKey(db, id)).toBeNull();
  });
});

describe('validateProvider', () => {
  function mockFetch(impl: (url: string, init?: RequestInit) => Response): void {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        return Promise.resolve(impl(u, init));
      }),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('anthropic 200 → ok with latency', async () => {
    mockFetch(() => new Response('{}', { status: 200 }));
    const result = await validateProvider({
      kind: 'anthropic',
      model: 'claude-opus-4-7',
      api_key: 'sk-ant-good',
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    [401, 'auth_failed'],
    [403, 'auth_failed'],
    [429, 'rate_limited'],
    [500, 'other'],
  ])('anthropic %i → reason=%s', async (status, reason) => {
    mockFetch(() => new Response('', { status }));
    const result = await validateProvider({
      kind: 'anthropic',
      model: 'claude-opus-4-7',
      api_key: 'sk-ant-bad',
    });
    expect(result).toMatchObject({ ok: false, reason });
  });

  it("surfaces the provider's own error message in `detail`", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: { message: 'Incorrect API key provided.' } }), {
          status: 401,
        }),
    );
    const result = await validateProvider({
      kind: 'openai',
      model: 'gpt-5',
      api_key: 'sk-bad',
    });
    expect(result).toEqual({
      ok: false,
      reason: 'auth_failed',
      detail: 'Incorrect API key provided.',
    });
  });

  it('uses /v1/models for OpenAI (decoupled from model choice)', async () => {
    let calledUrl = '';
    mockFetch((url) => {
      calledUrl = url;
      return new Response('{"data":[]}', { status: 200 });
    });
    const result = await validateProvider({
      kind: 'openai',
      model: 'gpt-5',
      api_key: 'sk-test',
    });
    expect(result.ok).toBe(true);
    expect(calledUrl).toBe('https://api.openai.com/v1/models');
  });

  it('missing api_key short-circuits to auth_failed (no fetch)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await validateProvider({
      kind: 'openai',
      model: 'gpt-5',
    });
    expect(result).toEqual({ ok: false, reason: 'auth_failed' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ollama hits /api/version against base_url', async () => {
    let calledUrl = '';
    mockFetch((url) => {
      calledUrl = url;
      return new Response('{"version":"0.1.0"}', { status: 200 });
    });
    const result = await validateProvider({
      kind: 'ollama',
      model: 'llama3.1:70b',
      base_url: 'http://localhost:11434',
    });
    expect(result.ok).toBe(true);
    expect(calledUrl).toBe('http://localhost:11434/api/version');
  });

  it('network error → reason=network', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
    );
    const result = await validateProvider({
      kind: 'anthropic',
      model: 'claude-opus-4-7',
      api_key: 'sk-ant',
    });
    expect(result).toEqual({ ok: false, reason: 'network' });
  });
});
