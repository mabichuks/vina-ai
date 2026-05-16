import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useCancelSearch } from '../../src/api/resources.js';

afterEach(() => vi.restoreAllMocks());

function makeWrapper(client: QueryClient) {
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

describe('useCancelSearch', () => {
  it('POSTs { task_id } to /api/searches/cancel and resolves with the count', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ cancelled: 1 }), { status: 200 }),
    );
    const { result } = renderHook(() => useCancelSearch(), { wrapper: makeWrapper(new QueryClient()) });
    const res = await result.current.mutate({ task_id: 't1' });
    expect(res).toEqual({ cancelled: 1 });
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/searches/cancel'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('POSTs { site_id } when task_id is absent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ cancelled: 2 }), { status: 200 }),
    );
    const { result } = renderHook(() => useCancelSearch(), { wrapper: makeWrapper(new QueryClient()) });
    const res = await result.current.mutate({ site_id: 'google' });
    expect(res).toEqual({ cancelled: 2 });
    const calls = fetchSpy.mock.calls;
    const init = calls[0]![1] as RequestInit;
    expect(typeof init.body === 'string' && init.body.includes('"site_id":"google"')).toBe(true);
  });
});
