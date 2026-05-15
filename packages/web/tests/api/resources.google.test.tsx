import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useValidateSerpapiKey, useGoogleJobsStatus } from '../../src/api/resources.js';

function makeWrapper(client: QueryClient) {
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

describe('useValidateSerpapiKey', () => {
  it('POSTs to /api/sites/google/test with the candidate key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, latency_ms: 12 }), { status: 200 }),
    );
    const qc = new QueryClient();
    const { result } = renderHook(() => useValidateSerpapiKey(), { wrapper: makeWrapper(qc) });

    const res = await result.current.mutate('candidate-key');
    expect(res).toMatchObject({ ok: true });
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/sites/google/test'),
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('useGoogleJobsStatus', () => {
  it('returns not_configured when /api/sites google row has no session', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/api/sites')) {
        return new Response(
          JSON.stringify([
            {
              id: 'google',
              display_name: 'Google Jobs',
              kind: 'api',
              enabled: false,
              has_session: false,
              session_valid_at: null,
              last_search_at: null,
            },
          ]),
          { status: 200 },
        );
      }
      if (u.includes('/api/alerts')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      return new Response('{}', { status: 200 });
    });

    const qc = new QueryClient();
    const { result } = renderHook(() => useGoogleJobsStatus(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.data?.state).toBe('not_configured'));
  });

  it('returns key_invalid when an open serpapi_key_invalid alert exists for google', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/api/sites')) {
        return new Response(
          JSON.stringify([
            { id: 'google', display_name: 'Google Jobs', kind: 'api', enabled: true,
              has_session: true, session_valid_at: '2026-05-15T00:00:00Z', last_search_at: null },
          ]),
          { status: 200 },
        );
      }
      if (u.includes('/api/alerts')) {
        return new Response(
          JSON.stringify({
            items: [
              { id: 'a1', kind: 'serpapi_key_invalid', severity: 'action_required',
                status: 'open', site_id: 'google', title: 'x', description: 'y',
                created_at: '2026-05-15T00:00:00Z', payload: null, application_id: null, resolution_value: null, resolved_at: null },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    });

    const qc = new QueryClient();
    const { result } = renderHook(() => useGoogleJobsStatus(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.data?.state).toBe('key_invalid'));
  });
});
