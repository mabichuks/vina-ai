import type { Database as DatabaseType } from 'better-sqlite3';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { NotFoundError, ConflictError, type LlmProviderKind } from '@vina/shared';
import { buildModel } from '@vina/orchestrator';
import {
  findLlmProviderById,
  insertLlmProvider,
  updateLlmProvider,
  type LlmProviderRow,
} from '../db/repositories/llm-providers.js';
import { getOrInitSettings } from '../db/repositories/settings.js';
import { decrypt, encrypt } from '../secrets/vault.js';

/**
 * Service layer that combines the vault with the LLM provider repo. The repo
 * stays pure — it only ever sees ciphertext `Buffer`s. Any code that needs
 * plaintext (the orchestrator, the route handlers when validating a key)
 * goes through this module.
 */

export interface CreateProviderInput {
  kind: LlmProviderKind;
  label: string;
  model: string;
  base_url?: string | null;
  /** Plaintext API key. Required for non-Ollama providers. */
  api_key?: string | null;
}

export function createProvider(db: DatabaseType, input: CreateProviderInput): LlmProviderRow {
  return insertLlmProvider(db, {
    kind: input.kind,
    label: input.label,
    model: input.model,
    base_url: input.base_url ?? null,
    encrypted_api_key: input.api_key ? encrypt(input.api_key) : null,
  });
}

export interface UpdateProviderInput {
  label?: string;
  model?: string;
  base_url?: string | null;
  /**
   * Plaintext API key. `undefined` leaves the existing key alone;
   * `null` clears it; a string replaces it.
   */
  api_key?: string | null;
}

export function updateProvider(
  db: DatabaseType,
  id: string,
  patch: UpdateProviderInput,
): LlmProviderRow {
  return updateLlmProvider(db, id, {
    ...(patch.label !== undefined && { label: patch.label }),
    ...(patch.model !== undefined && { model: patch.model }),
    ...(patch.base_url !== undefined && { base_url: patch.base_url }),
    ...(patch.api_key !== undefined && {
      encrypted_api_key: patch.api_key === null ? null : encrypt(patch.api_key),
    }),
  });
}

/**
 * Returns the plaintext API key for a configured provider, or null for
 * providers that don't have one (e.g. Ollama). Used by the orchestrator to
 * construct the LangChain client.
 */
export function getDecryptedApiKey(db: DatabaseType, providerId: string): string | null {
  const row = findLlmProviderById(db, providerId);
  if (!row) throw new NotFoundError(`LLM provider ${providerId} not found`);
  if (!row.encrypted_api_key) return null;
  return decrypt(row.encrypted_api_key);
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export type ValidateResult =
  | { ok: true; latency_ms: number }
  | {
      ok: false;
      reason: 'auth_failed' | 'rate_limited' | 'network' | 'other';
      /** The provider's own error message when available — surfaced verbatim. */
      detail?: string;
    };

export interface ValidateProviderInput {
  kind: LlmProviderKind;
  model: string;
  api_key?: string | null;
  base_url?: string | null;
}

/**
 * Confirms the user's credentials work before we save them. Uses the
 * lightest endpoint per provider — model-listing where available — so
 * validation is decoupled from whether the user picked a particular model
 * (and from model-specific param quirks like `max_completion_tokens`).
 *
 * Network errors and unexpected HTTP statuses collapse to a typed `reason`
 * so the UI can render the right message inline.
 */
export async function validateProvider(input: ValidateProviderInput): Promise<ValidateResult> {
  switch (input.kind) {
    case 'anthropic':
      return validateAnthropic(input.api_key ?? '');
    case 'openai':
      return validateOpenai(input.api_key ?? '');
    case 'ollama':
      return validateOllama(input.base_url ?? 'http://localhost:11434');
    case 'ollama-cloud':
      return validateOllamaCloud(input.api_key ?? '');
  }
}

async function fetchWithTiming(
  url: string,
  init: RequestInit,
): Promise<{ res: Response; latency_ms: number }> {
  const started = Date.now();
  const res = await fetch(url, init);
  return { res, latency_ms: Date.now() - started };
}

interface ProviderErrorBody {
  error?: { message?: string; type?: string } | string;
}

async function readDetail(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as ProviderErrorBody;
    if (typeof body.error === 'string') return body.error;
    if (body.error?.message) return body.error.message;
  } catch {
    // ignore — leave detail undefined
  }
  return undefined;
}

async function classifyResponse(res: Response): Promise<ValidateResult> {
  const detail = await readDetail(res);
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: 'auth_failed', ...(detail && { detail }) };
  }
  if (res.status === 429) {
    return { ok: false, reason: 'rate_limited', ...(detail && { detail }) };
  }
  return {
    ok: false,
    reason: 'other',
    detail: detail ?? `HTTP ${res.status}`,
  };
}

async function validateAnthropic(apiKey: string): Promise<ValidateResult> {
  if (!apiKey) return { ok: false, reason: 'auth_failed' };
  try {
    const { res, latency_ms } = await fetchWithTiming('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });
    if (res.ok) return { ok: true, latency_ms };
    return await classifyResponse(res);
  } catch {
    return { ok: false, reason: 'network' };
  }
}

async function validateOpenai(apiKey: string): Promise<ValidateResult> {
  if (!apiKey) return { ok: false, reason: 'auth_failed' };
  try {
    const { res, latency_ms } = await fetchWithTiming('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) return { ok: true, latency_ms };
    return await classifyResponse(res);
  } catch {
    return { ok: false, reason: 'network' };
  }
}

async function validateOllama(baseUrl: string): Promise<ValidateResult> {
  // Ollama runs locally without a key — a 200 from /api/version is enough.
  try {
    const { res, latency_ms } = await fetchWithTiming(new URL('/api/version', baseUrl).toString(), {
      method: 'GET',
    });
    if (res.ok) return { ok: true, latency_ms };
    return await classifyResponse(res);
  } catch {
    return { ok: false, reason: 'network' };
  }
}

/**
 * Validates a hosted Ollama Cloud key against the OpenAI-compatible endpoint
 * (https://ollama.com/v1). Prefers the model-listing endpoint; if the host
 * omits it (404/405), falls back to a minimal chat call so validation still
 * exercises the credential rather than the model list.
 */
async function validateOllamaCloud(apiKey: string): Promise<ValidateResult> {
  if (!apiKey) return { ok: false, reason: 'auth_failed' };
  const headers = { authorization: `Bearer ${apiKey}` };
  try {
    const list = await fetchWithTiming('https://ollama.com/v1/models', {
      method: 'GET',
      headers,
    });
    if (list.res.ok) return { ok: true, latency_ms: list.latency_ms };

    // Model listing not exposed — fall back to a minimal chat completion.
    if (list.res.status === 404 || list.res.status === 405) {
      const chat = await fetchWithTiming('https://ollama.com/v1/chat/completions', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-v4.1-flash:cloud',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
      });
      if (chat.res.ok) return { ok: true, latency_ms: chat.latency_ms };
      return await classifyResponse(chat.res);
    }

    return await classifyResponse(list.res);
  } catch {
    return { ok: false, reason: 'network' };
  }
}

/**
 * Resolves the user-selected active LLM provider, decrypts its key, and
 * returns a configured LangChain chat model. Throws ConflictError if no
 * provider is selected (a clear "configure provider first" UX) or
 * NotFoundError if the selected id has been deleted under us.
 */
export async function getActiveChatModel(db: DatabaseType): Promise<BaseChatModel> {
  const settings = getOrInitSettings(db);
  if (!settings.active_llm_provider_id) {
    throw new ConflictError('No active LLM provider configured');
  }
  const row = findLlmProviderById(db, settings.active_llm_provider_id);
  if (!row) {
    throw new NotFoundError(`Active LLM provider ${settings.active_llm_provider_id} not found`);
  }
  const apiKey = row.encrypted_api_key ? decrypt(row.encrypted_api_key) : null;
  return buildModel({
    kind: row.kind,
    model: row.model,
    ...(apiKey !== null && { apiKey }),
    ...(row.base_url !== null && { baseUrl: row.base_url }),
  });
}

/** OpenAI-compatible base URLs per provider kind, when no override is stored. */
const DEFAULT_BASE_URLS: Record<LlmProviderKind, string> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  ollama: 'http://localhost:11434/v1',
  'ollama-cloud': 'https://ollama.com/v1',
};

/**
 * Resolve the active provider into the shape the OpenCode host driver injects
 * (`{ model, baseURL, apiKey }`). Reuses the same settings + vault resolution
 * as `getActiveChatModel` but returns plain fields instead of a LangChain
 * model — the host routes every provider through `@ai-sdk/openai-compatible`.
 *
 * The key is decrypted here and returned **in memory only**; the host driver
 * must never write or log it (ADR-024 §9).
 */
export async function resolveChatProvider(db: DatabaseType): Promise<{
  model: string;
  baseURL: string;
  apiKey: string | null;
}> {
  const settings = getOrInitSettings(db);
  if (!settings.active_llm_provider_id) {
    throw new ConflictError('No active LLM provider configured');
  }
  const row = findLlmProviderById(db, settings.active_llm_provider_id);
  if (!row) {
    throw new NotFoundError(`Active LLM provider ${settings.active_llm_provider_id} not found`);
  }
  const apiKey = row.encrypted_api_key ? decrypt(row.encrypted_api_key) : null;
  return {
    model: row.model,
    baseURL: row.base_url ?? DEFAULT_BASE_URLS[row.kind],
    apiKey,
  };
}
