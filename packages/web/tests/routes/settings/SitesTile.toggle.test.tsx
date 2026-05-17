import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { SitesTile } from '../../../src/routes/settings/SitesTile.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockSites(rows: Array<Record<string, unknown>>, alerts: Array<Record<string, unknown>> = []): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    const method = (init as RequestInit | undefined)?.method ?? 'GET';
    if (u.endsWith('/api/sites') && method === 'GET') {
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    if (u.endsWith('/api/sites/linkedin') && method === 'PATCH') {
      return new Response(JSON.stringify({ id: 'linkedin', enabled: false }), { status: 200 });
    }
    if (u.endsWith('/api/sites/google') && method === 'PATCH') {
      return new Response(JSON.stringify({ id: 'google', enabled: true }), { status: 200 });
    }
    if (u.includes('/api/alerts')) {
      return new Response(JSON.stringify({ items: alerts }), { status: 200 });
    }
    if (u.includes('/api/sites/linkedin/status')) {
      return new Response(JSON.stringify({ connected: true, attempting: false, last_success_at: '2026-05-16T10:00:00Z', error: null }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
}

const row = (over: Record<string, unknown>): Record<string, unknown> => ({
  has_session: false,
  has_credentials: true,
  session_valid_at: null,
  last_search_at: null,
  ...over,
});

function renderTile(): void {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SitesTile />
    </QueryClientProvider>,
  );
}

describe('SitesTile — per-source toggle', () => {
  it('renders the LinkedIn switch ON when enabled=true && has_credentials=true', async () => {
    mockSites([
      row({ id: 'linkedin', display_name: 'LinkedIn', kind: 'browser', enabled: true, has_session: true, session_valid_at: '2026-05-15T10:00:00Z' }),
      row({ id: 'google', display_name: 'Google Jobs', kind: 'api', enabled: false }),
    ]);
    renderTile();
    const linkedinSwitch = await screen.findByRole('switch', { name: /linkedin/i });
    await waitFor(() => expect(linkedinSwitch.getAttribute('data-state')).toBe('checked'));
  });

  it('renders the Google Jobs switch OFF when enabled=false but has_credentials=true (paused)', async () => {
    mockSites([
      row({ id: 'linkedin', display_name: 'LinkedIn', kind: 'browser', enabled: true, has_session: true }),
      row({ id: 'google', display_name: 'Google Jobs', kind: 'api', enabled: false }),
    ]);
    renderTile();
    const googleSwitch = await screen.findByRole('switch', { name: /google jobs/i });
    await waitFor(() => expect(googleSwitch.getAttribute('data-state')).toBe('unchecked'));
  });

  it('PATCHes /api/sites/:id when the switch is clicked', async () => {
    const fetchSpy = mockSites([
      row({ id: 'linkedin', display_name: 'LinkedIn', kind: 'browser', enabled: true, has_session: true }),
      row({ id: 'google', display_name: 'Google Jobs', kind: 'api', enabled: false }),
    ]);
    renderTile();
    const sw = await screen.findByRole('switch', { name: /linkedin/i });
    await waitFor(() => expect(sw.getAttribute('data-state')).toBe('checked'));
    fireEvent.click(sw);
    await waitFor(() => {
      const patches = fetchSpy.mock.calls.filter(([url, init]) =>
        String(url).endsWith('/api/sites/linkedin') && (init as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(patches.length).toBe(1);
      const body = JSON.parse((patches[0]![1] as RequestInit).body as string);
      expect(body.enabled).toBe(false);
    });
  });

  it('disables the switch when has_credentials=false', async () => {
    mockSites([
      row({ id: 'linkedin', display_name: 'LinkedIn', kind: 'browser', enabled: false, has_credentials: false }),
      row({ id: 'google', display_name: 'Google Jobs', kind: 'api', enabled: false, has_credentials: false }),
    ]);
    renderTile();
    const sw = await screen.findByRole('switch', { name: /google jobs/i });
    await waitFor(() => expect(sw).toBeDisabled());
  });
});
