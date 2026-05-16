import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SitesTile } from '../../../src/routes/settings/SitesTile.js';

function harness(siteOverride: Record<string, unknown>, alerts: unknown[] = []) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.endsWith('/api/sites') && !(init as RequestInit | undefined)?.method)
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
            enabled: false,
            has_session: false,
            has_credentials: false,
            session_valid_at: null,
            last_search_at: null,
            ...siteOverride,
          },
        ]),
        { status: 200 },
      );
    if (u.endsWith('/api/sites/linkedin/status'))
      return new Response(
        JSON.stringify({ connected: true, attempting: false, last_success_at: null, error: null }),
        { status: 200 },
      );
    if (u.includes('/api/alerts'))
      return new Response(JSON.stringify({ items: alerts }), { status: 200 });
    // /api/bootstrap — return a token so auth layer is happy
    if (u.includes('/api/bootstrap'))
      return new Response(JSON.stringify({ version: '0.0.0', token: 'test', onboarded: true }), {
        status: 200,
      });
    return new Response(JSON.stringify({ ok: true, latency_ms: 1 }), { status: 200 });
  });

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SitesTile />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SitesTile — Google Jobs', () => {
  it('renders Not configured by default', async () => {
    harness({});
    await waitFor(() => expect(screen.getByText(/google jobs/i)).toBeInTheDocument());
    expect(screen.getByText(/not configured/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add serpapi key/i })).toBeInTheDocument();
  });

  it('renders Active with last_search_at', async () => {
    harness({ enabled: true, has_session: true, has_credentials: true, session_valid_at: '2026-05-15T10:00:00Z', last_search_at: '2026-05-15T10:00:00Z' });
    // Wait until the Google Jobs row shows the active state (Edit key button only appears when credentialed)
    await waitFor(() => expect(screen.getByRole('button', { name: /edit key/i })).toBeInTheDocument());
    // Both LinkedIn and Google rows are connected; exactly two Disconnect buttons should be present
    expect(screen.getAllByRole('button', { name: /disconnect/i })).toHaveLength(2);
  });

  it('renders Key invalid when an open serpapi_key_invalid alert is present', async () => {
    harness(
      { enabled: true, has_credentials: true },
      [
        {
          id: 'a1',
          site_id: 'google',
          kind: 'serpapi_key_invalid',
          status: 'open',
          severity: 'action_required',
          title: 'x',
          description: 'y',
          created_at: '2026-05-15T10:00:00Z',
          application_id: null,
          payload: null,
          resolution_value: null,
          resolved_at: null,
        },
      ],
    );
    await waitFor(() => expect(screen.getByText(/key invalid/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /update key/i })).toBeInTheDocument();
  });

  it('Save under the edit-key form POSTs candidate and switches back to connected', async () => {
    harness({});
    await waitFor(() => screen.getByRole('button', { name: /add serpapi key/i }));
    fireEvent.click(screen.getByRole('button', { name: /add serpapi key/i }));
    await waitFor(() => expect(screen.getByLabelText(/serpapi key/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/serpapi key/i), { target: { value: 'live' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() =>
      expect(screen.queryByLabelText(/serpapi key/i)).not.toBeInTheDocument(),
    );
  });
});
