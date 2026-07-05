import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import { ApplicationsPage } from '../../../src/routes/applications/ApplicationsPage.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const AUTO_APP_ID = 'app-auto-1';
const MANUAL_APP_ID = 'app-manual-1';
const JOB_ID = 'job-1';

const AUTO_ROW = {
  id: AUTO_APP_ID,
  job_id: JOB_ID,
  cv_id: 'cv-1',
  cover_letter_id: null,
  apply_method: 'auto',
  tailored_cv_path: null,
  tailored_cover_letter_path: null,
  tailored_cv_pdf_path: null,
  tailored_cover_letter_pdf_path: null,
  tailored_at: null,
  status: 'awaiting_user',
  started_at: new Date().toISOString(),
  submitted_at: null,
  applied_manually_at: null,
  applied_manually_notes: null,
  failure_reason: 'form_unclear',
  form_state: null,
  job: {
    id: JOB_ID,
    title: 'Engineer',
    company: 'Acme',
    location: null,
    match_score: 85,
    apply_method: 'auto',
    url: 'https://linkedin.com/jobs/1',
  },
};

const MANUAL_ROW = {
  id: MANUAL_APP_ID,
  job_id: 'job-2',
  cv_id: 'cv-1',
  cover_letter_id: null,
  apply_method: 'manual',
  tailored_cv_path: null,
  tailored_cover_letter_path: null,
  tailored_cv_pdf_path: null,
  tailored_cover_letter_pdf_path: null,
  tailored_at: null,
  status: 'ready_for_manual_apply',
  started_at: new Date().toISOString(),
  submitted_at: null,
  applied_manually_at: null,
  applied_manually_notes: null,
  failure_reason: null,
  form_state: null,
  job: {
    id: 'job-2',
    title: 'Designer',
    company: 'Corp',
    location: null,
    match_score: 70,
    apply_method: 'manual',
    url: 'https://linkedin.com/jobs/2',
  },
};

const APPS_RESPONSE = { items: [AUTO_ROW, MANUAL_ROW] };

function renderPage(): ReturnType<typeof vi.spyOn> {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    const method = (init as RequestInit | undefined)?.method ?? 'GET';
    if (u.includes('/api/applications') && method === 'GET') {
      return new Response(JSON.stringify(APPS_RESPONSE), { status: 200 });
    }
    if (u.includes('/api/applications') && u.includes('/retry') && method === 'POST') {
      return new Response(
        JSON.stringify({ application_id: 'app-new-1', status: 'queued', deduped: false }),
        { status: 202 },
      );
    }
    return new Response('{}', { status: 200 });
  });

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ApplicationsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return fetchSpy;
}

describe('ApplicationsPage Retry button', () => {
  it('renders exactly one Retry button for the auto+awaiting_user row only', async () => {
    renderPage();
    const retryButtons = await screen.findAllByRole('button', { name: /retry/i });
    expect(retryButtons).toHaveLength(1);
  });

  it('clicking Retry posts to /api/applications/:id/retry', async () => {
    const fetchSpy = renderPage();
    const btn = await screen.findByRole('button', { name: /retry/i });
    fireEvent.click(btn);
    await waitFor(() => {
      const retryCalls = fetchSpy.mock.calls.filter(([u, init]) => {
        const url = String(u);
        const method = (init as RequestInit | undefined)?.method ?? 'GET';
        return url.includes(`/api/applications/${AUTO_APP_ID}/retry`) && method === 'POST';
      });
      expect(retryCalls).toHaveLength(1);
    });
  });
});
