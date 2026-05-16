import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { SearchActivityPanel } from '../../../src/components/search/SearchActivityPanel.js';
import { useSearchProgressStore } from '../../../src/store/search-progress-store.js';

afterEach(() => {
  cleanup();
  useSearchProgressStore.getState().reset();
  vi.restoreAllMocks();
});

function renderPanel(): { rerender: () => void } {
  const { rerender } = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SearchActivityPanel />
    </QueryClientProvider>,
  );
  return {
    rerender: () =>
      rerender(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <SearchActivityPanel />
        </QueryClientProvider>,
      ),
  };
}

describe('SearchActivityPanel — Stop button', () => {
  it('renders Stop only during the discovering phase', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    useSearchProgressStore.getState().beginDiscovering({ taskId: 't1' });
    const { rerender } = renderPanel();
    expect(await screen.findByRole('button', { name: /stop/i })).toBeInTheDocument();

    useSearchProgressStore.getState().beginScoring(5);
    rerender();
    expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument();
  });

  it('POSTs /api/searches/cancel { task_id } on click', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/api/searches/cancel') && (init as RequestInit | undefined)?.method === 'POST') {
        return new Response(JSON.stringify({ cancelled: 1 }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    useSearchProgressStore.getState().beginDiscovering({ taskId: 't42' });
    renderPanel();
    const stop = await screen.findByRole('button', { name: /stop/i });
    fireEvent.click(stop);
    await waitFor(() => {
      const cancels = fetchSpy.mock.calls.filter(
        ([url, init]) =>
          String(url).endsWith('/api/searches/cancel') &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(cancels.length).toBe(1);
      const body = JSON.parse((cancels[0]![1] as RequestInit).body as string);
      expect(body.task_id).toBe('t42');
    });
  });

  it('prefixes "Cancelled" in the headline after a search:cancelled transition', () => {
    useSearchProgressStore.getState().beginDiscovering({ taskId: 't1' });
    useSearchProgressStore.getState().markCancelled();
    renderPanel();
    expect(screen.getByText(/cancelled/i)).toBeInTheDocument();
  });
});
