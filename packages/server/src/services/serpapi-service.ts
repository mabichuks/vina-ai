/**
 * Stub SerpAPI client. Phase 5 only needs `validateSerpApiKey` so the
 * onboarding wizard / settings can confirm a key works. The real Google
 * Jobs query implementation lands in Phase 13 (PRD-140).
 */

export type ValidateResult =
  | { ok: true; latency_ms: number }
  | {
      ok: false;
      reason: 'auth_failed' | 'rate_limited' | 'network' | 'other';
      detail?: string;
    };

const SERPAPI_BASE = 'https://serpapi.com/search.json';

interface SerpApiErrorBody {
  error?: string;
}

/**
 * Confirms the supplied SerpAPI key works against the Google Jobs engine
 * with the cheapest possible query (single result, no extras).
 */
export async function validateSerpApiKey(plaintext: string): Promise<ValidateResult> {
  if (!plaintext) return { ok: false, reason: 'auth_failed' };

  const url = new URL(SERPAPI_BASE);
  url.searchParams.set('engine', 'google_jobs');
  url.searchParams.set('q', 'engineer');
  url.searchParams.set('num', '1');
  url.searchParams.set('api_key', plaintext);

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET' });
  } catch {
    return { ok: false, reason: 'network' };
  }
  const latency_ms = Date.now() - started;

  if (res.status === 401) return { ok: false, reason: 'auth_failed' };
  if (res.status === 429) return { ok: false, reason: 'rate_limited' };

  // SerpAPI returns 200 with `{ "error": "..." }` when the key is bad rather
  // than HTTP 401 — read the body to disambiguate.
  let body: SerpApiErrorBody = {};
  try {
    body = (await res.json()) as SerpApiErrorBody;
  } catch {
    return { ok: false, reason: 'other', detail: `non-JSON response ${res.status}` };
  }

  if (body.error) {
    const lower = body.error.toLowerCase();
    if (lower.includes('invalid api key') || lower.includes('unauthorized')) {
      return { ok: false, reason: 'auth_failed', detail: body.error };
    }
    if (lower.includes('limit') || lower.includes('exceeded')) {
      return { ok: false, reason: 'rate_limited', detail: body.error };
    }
    return { ok: false, reason: 'other', detail: body.error };
  }

  if (!res.ok) return { ok: false, reason: 'other', detail: `HTTP ${res.status}` };
  return { ok: true, latency_ms };
}
