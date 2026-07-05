import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { AnswersTile } from '../../../src/routes/settings/AnswersTile.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function wrap(ui: React.ReactNode): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const SEED = [
  {
    id: '1',
    key: 'years_typescript',
    label: 'Years of TypeScript?',
    value: '5',
    created_at: '2026-06-21T00:00:00.000Z',
    updated_at: '2026-06-21T00:00:00.000Z',
  },
  {
    id: '2',
    key: 'work_auth_us',
    label: 'Work auth in US?',
    value: 'No',
    created_at: '2026-06-21T00:00:00.000Z',
    updated_at: '2026-06-21T00:00:00.000Z',
  },
];

function mockAnswers(initial: typeof SEED): ReturnType<typeof vi.spyOn> {
  let answers = [...initial];
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    const method = (init as RequestInit | undefined)?.method ?? 'GET';
    if (u.endsWith('/api/profile-answers') && method === 'GET') {
      return new Response(JSON.stringify({ answers }), { status: 200 });
    }
    if (u.startsWith('/api/profile-answers/') && method === 'DELETE') {
      const key = decodeURIComponent(u.replace('/api/profile-answers/', ''));
      const before = answers.length;
      answers = answers.filter((a) => a.key !== key);
      return new Response(null, { status: answers.length < before ? 204 : 404 });
    }
    if (u.endsWith('/api/profile-answers') && method === 'DELETE') {
      answers = [];
      return new Response(null, { status: 204 });
    }
    throw new Error(`unmocked: ${method} ${u}`);
  });
}

describe('AnswersTile', () => {
  it('lists saved answers from the API', async () => {
    mockAnswers(SEED);
    render(wrap(<AnswersTile />));
    expect(await screen.findByText('Years of TypeScript?')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('Work auth in US?')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
  });

  it('removes a single answer when Forget is clicked', async () => {
    mockAnswers(SEED);
    render(wrap(<AnswersTile />));
    await screen.findByText('Years of TypeScript?');

    const forgetButtons = screen.getAllByRole('button', { name: /forget/i });
    fireEvent.click(forgetButtons[0]!);

    await waitFor(() =>
      expect(screen.queryByText('Years of TypeScript?')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('Work auth in US?')).toBeInTheDocument();
  });

  it('clears all answers after confirming the dialog', async () => {
    mockAnswers(SEED);
    render(wrap(<AnswersTile />));
    await screen.findByText('Years of TypeScript?');

    fireEvent.click(screen.getByRole('button', { name: /clear all/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

    await waitFor(() =>
      expect(screen.queryByText('Work auth in US?')).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/no saved answers/i)).toBeInTheDocument();
  });

  it('shows an empty state when there are no saved answers', async () => {
    mockAnswers([]);
    render(wrap(<AnswersTile />));
    expect(await screen.findByText(/no saved answers/i)).toBeInTheDocument();
  });
});
