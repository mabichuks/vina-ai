import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { EasyApplyTile } from '../../../src/routes/settings/EasyApplyTile.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function wrap(ui: React.ReactNode): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const BASE_SETTINGS = {
  id: 'app',
  easy_apply_mode: 'manual',
  autonomous_apply_dry_run: false,
  apply_daily_cap: 10,
  apply_min_interval_seconds: 300,
  apply_listing_max_age_days: 14,
  apply_consecutive_failure_limit: 5,
  browser_headful: false,
  browser_stealth: false,
  paused: false,
  active_llm_provider_id: null,
  has_serpapi_key: false,
  updated_at: '2026-06-21T00:00:00.000Z',
};

function mockSettings(initial = BASE_SETTINGS): {
  spy: ReturnType<typeof vi.spyOn>;
  patches: () => unknown[];
} {
  let current = { ...initial };
  const patches: unknown[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    const method = (init as RequestInit | undefined)?.method ?? 'GET';
    if (u.endsWith('/api/settings') && method === 'GET') {
      return new Response(JSON.stringify(current), { status: 200 });
    }
    if (u.endsWith('/api/settings') && method === 'PATCH') {
      const body = JSON.parse((init as RequestInit).body as string);
      patches.push(body);
      current = { ...current, ...body };
      return new Response(JSON.stringify(current), { status: 200 });
    }
    throw new Error(`unmocked ${method} ${u}`);
  });
  return { spy, patches: () => patches };
}

describe('EasyApplyTile', () => {
  it('switching to autonomous opens the risk dialog before patching', async () => {
    const { patches } = mockSettings();
    render(wrap(<EasyApplyTile />));
    await screen.findByRole('radio', { name: /manual/i });

    fireEvent.click(screen.getByRole('radio', { name: /autonomous/i }));

    expect(await screen.findByText(/risks of autonomous mode/i)).toBeInTheDocument();
    expect(patches()).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /i understand/i }));

    await waitFor(() =>
      expect(patches()).toContainEqual({ easy_apply_mode: 'autonomous' }),
    );
  });

  it('cancelling the risk dialog leaves the mode unchanged', async () => {
    const { patches } = mockSettings();
    render(wrap(<EasyApplyTile />));
    await screen.findByRole('radio', { name: /manual/i });

    fireEvent.click(screen.getByRole('radio', { name: /autonomous/i }));
    await screen.findByText(/risks of autonomous mode/i);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() =>
      expect(screen.queryByText(/risks of autonomous mode/i)).not.toBeInTheDocument(),
    );
    expect(patches()).toHaveLength(0);
  });

  it('commits the daily cap on blur when changed to a valid value', async () => {
    const { patches } = mockSettings();
    render(wrap(<EasyApplyTile />));
    const capInput = await screen.findByLabelText(/daily easy apply cap/i);

    fireEvent.change(capInput, { target: { value: '25' } });
    fireEvent.blur(capInput);

    await waitFor(() =>
      expect(patches()).toContainEqual({ apply_daily_cap: 25 }),
    );
  });

  it('toggles dry-run via the checkbox', async () => {
    const { patches } = mockSettings();
    render(wrap(<EasyApplyTile />));
    const cb = await screen.findByLabelText(/dry-run/i);

    fireEvent.click(cb);

    await waitFor(() =>
      expect(patches()).toContainEqual({ autonomous_apply_dry_run: true }),
    );
  });
});
