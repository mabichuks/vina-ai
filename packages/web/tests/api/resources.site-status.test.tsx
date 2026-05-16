import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useSiteStatus } from '../../src/api/resources.js';

afterEach(() => vi.restoreAllMocks());

function makeWrapper(client: QueryClient) {
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

function mockSitesAndAlerts(rows: Array<Record<string, unknown>>, alerts: Array<Record<string, unknown>> = []): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const u = String(url);
    if (u.endsWith('/api/sites')) {
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    if (u.includes('/api/alerts')) {
      return new Response(JSON.stringify({ items: alerts }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
}

describe('useSiteStatus', () => {
  it('returns not_configured when has_credentials=false regardless of enabled', async () => {
    mockSitesAndAlerts([
      { id: 'google', display_name: 'Google Jobs', kind: 'api', enabled: true,
        has_session: false, has_credentials: false, session_valid_at: null, last_search_at: null },
    ]);
    const { result } = renderHook(() => useSiteStatus('google'), { wrapper: makeWrapper(new QueryClient()) });
    await waitFor(() => expect(result.current.data?.state).toBe('not_configured'));
    expect(result.current.data?.has_credentials).toBe(false);
  });

  it('returns paused when has_credentials=true && enabled=false', async () => {
    mockSitesAndAlerts([
      { id: 'google', display_name: 'Google Jobs', kind: 'api', enabled: false,
        has_session: false, has_credentials: true, session_valid_at: null, last_search_at: null },
    ]);
    const { result } = renderHook(() => useSiteStatus('google'), { wrapper: makeWrapper(new QueryClient()) });
    await waitFor(() => expect(result.current.data?.state).toBe('paused'));
  });

  it('returns active when has_credentials=true && enabled=true with no degraded alerts', async () => {
    mockSitesAndAlerts([
      { id: 'google', display_name: 'Google Jobs', kind: 'api', enabled: true,
        has_session: false, has_credentials: true, session_valid_at: null, last_search_at: '2026-05-16T10:00:00Z' },
    ]);
    const { result } = renderHook(() => useSiteStatus('google'), { wrapper: makeWrapper(new QueryClient()) });
    await waitFor(() => expect(result.current.data?.state).toBe('active'));
  });

  it('key_invalid alert beats active', async () => {
    mockSitesAndAlerts(
      [
        { id: 'google', display_name: 'Google Jobs', kind: 'api', enabled: true,
          has_session: false, has_credentials: true, session_valid_at: null, last_search_at: null },
      ],
      [
        { id: 'a1', kind: 'serpapi_key_invalid', severity: 'action_required', status: 'open',
          site_id: 'google', title: 'x', description: 'y', created_at: '2026-05-16T00:00:00Z',
          payload: null, application_id: null, resolution_value: null, resolved_at: null },
      ],
    );
    const { result } = renderHook(() => useSiteStatus('google'), { wrapper: makeWrapper(new QueryClient()) });
    await waitFor(() => expect(result.current.data?.state).toBe('key_invalid'));
  });
});
