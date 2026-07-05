import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import { JobsPage } from '../../../src/routes/jobs/JobsPage.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const EMPTY_JOBS = { items: [], page: 1, page_size: 10, total: 0 };
const EMPTY_APPS = { items: [] };
const PREFS = { score_threshold: 70 };
const LI_STATUS = { connected: false, attempting: false, last_success_at: null, error: null };
const SITES: unknown[] = [];
const ALERTS = { items: [] };

function renderJobsPage(): ReturnType<typeof vi.spyOn> {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes('/api/jobs')) {
      return new Response(JSON.stringify(EMPTY_JOBS), { status: 200 });
    }
    if (u.includes('/api/search-preferences')) {
      return new Response(JSON.stringify(PREFS), { status: 200 });
    }
    if (u.includes('/api/sites/linkedin/status')) {
      return new Response(JSON.stringify(LI_STATUS), { status: 200 });
    }
    if (u.includes('/api/applications')) {
      return new Response(JSON.stringify(EMPTY_APPS), { status: 200 });
    }
    if (u.includes('/api/alerts')) {
      return new Response(JSON.stringify(ALERTS), { status: 200 });
    }
    if (u.includes('/api/sites')) {
      return new Response(JSON.stringify(SITES), { status: 200 });
    }
    // Fallback: return empty JSON so unexpected routes don't throw
    return new Response('{}', { status: 200 });
  });

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <JobsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return fetchSpy;
}

describe('JobsPage sort and filter controls', () => {
  it('renders sort and filter controls with defaults', async () => {
    renderJobsPage();
    expect(await screen.findByLabelText(/sort/i)).toHaveValue('score');
    expect(screen.getByLabelText(/apply type/i)).toHaveValue('');
    expect(screen.getByLabelText(/source/i)).toHaveValue('');
  });

  it('changing a control adds the param to the jobs request', async () => {
    const fetchSpy = renderJobsPage();
    fireEvent.change(await screen.findByLabelText(/apply type/i), {
      target: { value: 'auto' },
    });
    await waitFor(() => {
      const jobCalls = fetchSpy.mock.calls
        .map(([u]) => String(u))
        .filter((u) => u.includes('/api/jobs?'));
      expect(jobCalls.at(-1)).toContain('apply_method=auto');
      expect(jobCalls.at(-1)).toContain('page=1');
    });
  });
});
