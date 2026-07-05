import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import { ApplicationsPage, groupByJob } from '../../../src/routes/applications/ApplicationsPage.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Job A: two attempts — newer is submitted, older is failed
const JOB_A_ID = 'job-a';
const ROW_A_NEW = {
  id: 'app-a-new',
  job_id: JOB_A_ID,
  cv_id: 'cv-1',
  cover_letter_id: null,
  apply_method: 'auto',
  tailored_cv_path: null,
  tailored_cover_letter_path: null,
  tailored_cv_pdf_path: null,
  tailored_cover_letter_pdf_path: null,
  tailored_at: null,
  status: 'submitted',
  started_at: '2026-07-05T10:00:00.000Z',
  submitted_at: null,
  applied_manually_at: null,
  applied_manually_notes: null,
  failure_reason: null,
  form_state: null,
  job: {
    id: JOB_A_ID,
    title: 'Job A Title',
    company: 'Acme',
    location: null,
    match_score: 90,
    apply_method: 'auto',
    url: 'https://linkedin.com/jobs/a',
  },
};
const ROW_A_OLD = {
  id: 'app-a-old',
  job_id: JOB_A_ID,
  cv_id: 'cv-1',
  cover_letter_id: null,
  apply_method: 'auto',
  tailored_cv_path: null,
  tailored_cover_letter_path: null,
  tailored_cv_pdf_path: null,
  tailored_cover_letter_pdf_path: null,
  tailored_at: null,
  status: 'failed',
  started_at: '2026-07-05T09:00:00.000Z',
  submitted_at: null,
  applied_manually_at: null,
  applied_manually_notes: null,
  failure_reason: 'form_unclear',
  form_state: null,
  job: {
    id: JOB_A_ID,
    title: 'Job A Title',
    company: 'Acme',
    location: null,
    match_score: 90,
    apply_method: 'auto',
    url: 'https://linkedin.com/jobs/a',
  },
};

// Job B: single attempt
const JOB_B_ID = 'job-b';
const ROW_B = {
  id: 'app-b',
  job_id: JOB_B_ID,
  cv_id: 'cv-1',
  cover_letter_id: null,
  apply_method: 'manual',
  tailored_cv_path: null,
  tailored_cover_letter_path: null,
  tailored_cv_pdf_path: null,
  tailored_cover_letter_pdf_path: null,
  tailored_at: null,
  status: 'ready_for_manual_apply',
  started_at: '2026-07-05T08:00:00.000Z',
  submitted_at: null,
  applied_manually_at: null,
  applied_manually_notes: null,
  failure_reason: null,
  form_state: null,
  job: {
    id: JOB_B_ID,
    title: 'Job B Title',
    company: 'Corp',
    location: null,
    match_score: 70,
    apply_method: 'manual',
    url: 'https://linkedin.com/jobs/b',
  },
};

const APPS_RESPONSE = { items: [ROW_A_NEW, ROW_A_OLD, ROW_B] };

function renderPage(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes('/api/applications')) {
      return new Response(JSON.stringify(APPS_RESPONSE), { status: 200 });
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
}

describe('groupByJob helper', () => {
  it('groups rows by job_id, latest first', () => {
    const rows = [ROW_A_NEW, ROW_A_OLD, ROW_B];
    const groups = groupByJob(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.latest.id).toBe('app-a-new');
    expect(groups[0]!.history).toHaveLength(1);
    expect(groups[0]!.history[0]!.id).toBe('app-a-old');
    expect(groups[1]!.latest.id).toBe('app-b');
    expect(groups[1]!.history).toHaveLength(0);
  });
});

describe('ApplicationsPage grouping', () => {
  it('shows one row per job with an attempts toggle', async () => {
    renderPage();
    // exactly one row per job at top level:
    expect(await screen.findAllByText(/Job A Title/)).toHaveLength(1);
    // the multi-attempt job shows the toggle, the single-attempt one doesn't:
    expect(screen.getByRole('button', { name: /2 attempts/i })).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: /attempts/i })).toHaveLength(1);
    // top-level row is the NEWER attempt (status rendered with spaces):
    expect(screen.getByText('submitted')).toBeInTheDocument();
    expect(screen.queryByText('failed')).not.toBeInTheDocument();
  });

  it('expanding reveals the older attempts', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /2 attempts/i }));
    expect(await screen.findByText('failed')).toBeInTheDocument();
  });
});
