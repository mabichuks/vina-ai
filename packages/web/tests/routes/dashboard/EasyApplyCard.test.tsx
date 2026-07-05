import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { EasyApplyCard } from '../../../src/routes/dashboard/EasyApplyCard.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function wrap(ui: React.ReactNode): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const SUMMARY = {
  submitted_today: 4,
  day_bucket: '2026-06-21',
  circuit_breaker_tripped: false,
  consecutive_failures: 0,
  easy_apply_mode: 'autonomous',
  daily_cap: 10,
  recent: [
    {
      application_id: 'a1',
      title: 'Senior Engineer',
      company: 'Acme',
      status: 'submitted',
      submitted_at: '2026-06-21T11:30:00.000Z',
      updated_at: '2026-06-21T11:30:00.000Z',
    },
  ],
};

describe('EasyApplyCard', () => {
  it('renders the daily count, mode, and recent applications', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/api/dashboard/easy-apply')) {
        return new Response(JSON.stringify(SUMMARY), { status: 200 });
      }
      throw new Error(`unmocked ${u}`);
    });
    render(wrap(<EasyApplyCard />));
    expect(await screen.findByText(/4 \/ 10/)).toBeInTheDocument();
    expect(screen.getByText('Senior Engineer')).toBeInTheDocument();
  });

  it('the kill switch flips the mode to manual', async () => {
    let mode: 'autonomous' | 'manual' = 'autonomous';
    let patched = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (u.endsWith('/api/dashboard/easy-apply')) {
        return new Response(
          JSON.stringify({ ...SUMMARY, easy_apply_mode: mode }),
          { status: 200 },
        );
      }
      if (u.endsWith('/api/settings') && method === 'PATCH') {
        const body = JSON.parse((init as RequestInit).body as string) as {
          easy_apply_mode?: 'autonomous' | 'manual';
        };
        if (body.easy_apply_mode) mode = body.easy_apply_mode;
        patched = true;
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    render(wrap(<EasyApplyCard />));
    fireEvent.click(await screen.findByRole('button', { name: /pause autonomous/i }));

    await waitFor(() => expect(patched).toBe(true));
    expect(mode).toBe('manual');
  });

  it('does not show the kill switch when mode is already manual', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ ...SUMMARY, easy_apply_mode: 'manual' }), { status: 200 }),
    );
    render(wrap(<EasyApplyCard />));
    await screen.findByText(/4 \/ 10/);
    expect(screen.queryByRole('button', { name: /pause autonomous/i })).not.toBeInTheDocument();
  });

  it('shows the circuit-breaker banner when tripped', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({
          ...SUMMARY,
          circuit_breaker_tripped: true,
          consecutive_failures: 6,
          easy_apply_mode: 'manual',
        }),
        { status: 200 },
      ),
    );
    render(wrap(<EasyApplyCard />));
    expect(
      await screen.findByText(/circuit breaker tripped/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/6 consecutive failures/i)).toBeInTheDocument();
  });
});
