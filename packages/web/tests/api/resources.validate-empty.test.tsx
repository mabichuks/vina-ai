import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useValidateSerpapiKey } from '../../src/api/resources.js';

afterEach(() => vi.restoreAllMocks());

function makeWrapper(client: QueryClient) {
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

describe('useValidateSerpapiKey — empty-key fence', () => {
  it('resolves locally with empty_key for an empty string; no fetch happens', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    const { result } = renderHook(() => useValidateSerpapiKey(), { wrapper: makeWrapper(new QueryClient()) });
    const res = await result.current.mutate('');
    expect(res).toMatchObject({ ok: false, reason: 'empty_key', detail: 'Key is required' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves locally for whitespace-only', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );
    const { result } = renderHook(() => useValidateSerpapiKey(), { wrapper: makeWrapper(new QueryClient()) });
    const res = await result.current.mutate('   ');
    expect(res).toMatchObject({ ok: false, reason: 'empty_key' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still POSTs for a non-empty key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, latency_ms: 5 }), { status: 200 }),
    );
    const { result } = renderHook(() => useValidateSerpapiKey(), { wrapper: makeWrapper(new QueryClient()) });
    await result.current.mutate('live-key');
    expect(fetchSpy).toHaveBeenCalled();
  });
});
