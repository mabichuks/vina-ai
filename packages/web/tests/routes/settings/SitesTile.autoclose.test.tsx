import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { SitesTile } from '../../../src/routes/settings/SitesTile.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SitesTile — B2 auto-close edit form', () => {
  it('closes the inline edit-key form when state transitions to not_configured', async () => {
    let credentialsPresent = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (u.endsWith('/api/sites') && method === 'GET') {
        return new Response(
          JSON.stringify([
            {
              id: 'linkedin',
              display_name: 'LinkedIn',
              kind: 'browser',
              enabled: true,
              has_session: true,
              has_credentials: true,
              session_valid_at: '2026-05-15T10:00:00Z',
              last_search_at: null,
            },
            {
              id: 'google',
              display_name: 'Google Jobs',
              kind: 'api',
              enabled: credentialsPresent,
              has_session: false,
              has_credentials: credentialsPresent,
              session_valid_at: null,
              last_search_at: null,
            },
          ]),
          { status: 200 },
        );
      }
      if (u.endsWith('/api/sites/google') && method === 'DELETE') {
        credentialsPresent = false;
        return new Response(null, { status: 204 });
      }
      if (u.includes('/api/alerts')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (u.includes('/api/sites/linkedin/status')) {
        return new Response(JSON.stringify({ connected: true, attempting: false, last_success_at: null, error: null }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SitesTile />
      </QueryClientProvider>,
    );

    // Open the edit-key form on the Google row (state starts as 'active').
    const editButton = await screen.findByRole('button', { name: /edit key/i });
    fireEvent.click(editButton);
    expect(await screen.findByLabelText(/serpapi key/i)).toBeInTheDocument();

    // Disconnect → server flips has_credentials → next refetch → state becomes not_configured.
    const disconnectButtons = screen.getAllByRole('button', { name: /disconnect/i });
    // Pick the Disconnect button inside the Google row — both LinkedIn and Google
    // currently render one. The Google row is the last item in the list.
    fireEvent.click(disconnectButtons[disconnectButtons.length - 1]!);

    // The input element should be removed from the DOM once state flips.
    await waitFor(() => expect(screen.queryByLabelText(/serpapi key/i)).not.toBeInTheDocument(), {
      timeout: 3_000,
    });
  });
});
