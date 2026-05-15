import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GoogleJobs } from '../../../src/routes/onboarding/steps/GoogleJobs.js';

function renderStep() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/onboarding/google-jobs']}>
        <Routes>
          <Route path="/onboarding/google-jobs" element={<GoogleJobs />} />
          <Route path="/onboarding/preferences" element={<div>PREFS</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('GoogleJobs wizard step', () => {
  it('renders an initial state with key input and Skip', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }));
    renderStep();
    expect(screen.getByRole('button', { name: /enable google jobs/i })).toBeInTheDocument();
    expect(screen.getByText(/skip for now/i)).toBeInTheDocument();
  });

  it('on Enable, validates the key and advances to /preferences on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/api/sites/google/test')) {
        return new Response(JSON.stringify({ ok: true, latency_ms: 5 }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    renderStep();
    fireEvent.change(screen.getByLabelText(/serpapi key/i), { target: { value: 'live-key' } });
    fireEvent.click(screen.getByRole('button', { name: /enable google jobs/i }));
    await waitFor(() => expect(screen.getByText('PREFS')).toBeInTheDocument(), { timeout: 3000 });
  });

  it('shows a red banner on invalid key', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/api/sites/google/test')) {
        return new Response(JSON.stringify({ ok: false, reason: 'auth_failed' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    renderStep();
    fireEvent.change(screen.getByLabelText(/serpapi key/i), { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: /enable google jobs/i }));
    await waitFor(() => expect(screen.getByText(/we couldn.t verify/i)).toBeInTheDocument());
  });

  it('Skip routes to /preferences without calling /test', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }));
    renderStep();
    fireEvent.click(screen.getByText(/skip for now/i));
    await waitFor(() => expect(screen.getByText('PREFS')).toBeInTheDocument());
    const calls = spy.mock.calls.filter((c) => String(c[0]).includes('/api/sites/google/test'));
    expect(calls.length).toBe(0);
  });
});
