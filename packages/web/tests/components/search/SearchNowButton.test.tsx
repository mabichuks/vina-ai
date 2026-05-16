import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { SearchNowButton } from '../../../src/components/search/SearchNowButton.js';
import { useSearchProgressStore } from '../../../src/store/search-progress-store.js';

afterEach(() => {
  cleanup();
  useSearchProgressStore.getState().reset();
  vi.restoreAllMocks();
});

function setup(siteRows: Array<Record<string, unknown>>): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    const method = (init as RequestInit | undefined)?.method ?? 'GET';
    if (u.endsWith('/api/sites') && method === 'GET') {
      return new Response(JSON.stringify(siteRows), { status: 200 });
    }
    if (u.includes('/api/alerts')) {
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }
    if (u.includes('/api/sites/linkedin/status')) {
      return new Response(JSON.stringify({ connected: true, attempting: false, last_success_at: null, error: null }), { status: 200 });
    }
    if (u.endsWith('/api/searches/run-now') && method === 'POST') {
      const body = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ task_id: `t-${body.site_id}`, deduped: false }), { status: 202 });
    }
    return new Response('{}', { status: 200 });
  });
}

const row = (id: string, enabled: boolean, has_credentials: boolean): Record<string, unknown> => ({
  id,
  display_name: id,
  kind: id === 'linkedin' ? 'browser' : 'api',
  enabled,
  has_session: id === 'linkedin' ? has_credentials : false,
  has_credentials,
  session_valid_at: null,
  last_search_at: null,
});

function renderButton(): void {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SearchNowButton />
    </QueryClientProvider>,
  );
}

describe('SearchNowButton — multi-source', () => {
  it('disabled with tooltip when zero sources are active', async () => {
    setup([row('linkedin', false, false), row('google', false, false)]);
    renderButton();
    const btn = await screen.findByRole('button', { name: /search now/i });
    await waitFor(() => expect(btn).toBeDisabled());
    expect(btn.getAttribute('title')).toMatch(/no source/i);
  });

  it('single-source: click fires one run-now for that site', async () => {
    const fetchSpy = setup([row('linkedin', true, true), row('google', false, false)]);
    renderButton();
    const btn = await screen.findByRole('button', { name: /search now/i });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    await waitFor(() => {
      const posts = fetchSpy.mock.calls.filter(([url, init]) =>
        String(url).endsWith('/api/searches/run-now') && (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(posts.length).toBe(1);
      expect(JSON.parse((posts[0]![1] as RequestInit).body as string).site_id).toBe('linkedin');
    });
  });

  it('two-source: clicking opens a dropdown with three options', async () => {
    setup([row('linkedin', true, true), row('google', true, true)]);
    renderButton();
    // Wait until the queries resolve and the dropdown trigger replaces the
    // initial disabled placeholder. The dropdown variant carries aria-haspopup.
    const trigger = await screen.findByRole('button', { expanded: false });
    await waitFor(() => expect(trigger.getAttribute('aria-haspopup')).toBe('menu'));
    const user = userEvent.setup();
    await user.click(trigger);
    expect(await screen.findByRole('menuitem', { name: /search both/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /linkedin only/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /google jobs only/i })).toBeInTheDocument();
  });

  it('two-source: "Search both" fires run-now twice with the two site_ids', async () => {
    const fetchSpy = setup([row('linkedin', true, true), row('google', true, true)]);
    renderButton();
    const trigger = await screen.findByRole('button', { expanded: false });
    await waitFor(() => expect(trigger.getAttribute('aria-haspopup')).toBe('menu'));
    const user = userEvent.setup();
    await user.click(trigger);
    const both = await screen.findByRole('menuitem', { name: /search both/i });
    await user.click(both);
    await waitFor(() => {
      const posts = fetchSpy.mock.calls.filter(([url, init]) =>
        String(url).endsWith('/api/searches/run-now') && (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(posts.length).toBe(2);
      const bodies = posts.map(([, init]) => JSON.parse((init as RequestInit).body as string).site_id).sort();
      expect(bodies).toEqual(['google', 'linkedin']);
    });
  });
});
