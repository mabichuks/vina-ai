import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../components/ui/button.js';

interface ProfileAnswer {
  id: string;
  key: string;
  label: string;
  value: string;
  created_at: string;
  updated_at: string;
}

async function fetchAnswers(): Promise<ProfileAnswer[]> {
  const r = await fetch('/api/profile-answers');
  if (!r.ok) throw new Error('Failed to fetch answers');
  const body = (await r.json()) as { answers: ProfileAnswer[] };
  return body.answers;
}

async function forgetAnswer(key: string): Promise<void> {
  const r = await fetch(`/api/profile-answers/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  });
  // 404 = already gone — treat as success so concurrent forgets don't error.
  if (!r.ok && r.status !== 404) throw new Error('Failed to forget answer');
}

async function clearAllAnswers(): Promise<void> {
  const r = await fetch('/api/profile-answers', { method: 'DELETE' });
  if (!r.ok) throw new Error('Failed to clear answers');
}

export function AnswersTile(): JSX.Element {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['profile-answers'],
    queryFn: fetchAnswers,
  });
  const forget = useMutation({
    mutationFn: forgetAnswer,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profile-answers'] }),
  });
  const clearAll = useMutation({
    mutationFn: clearAllAnswers,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['profile-answers'] });
      setConfirming(false);
    },
  });

  return (
    <section
      id="answers"
      className="rounded-lg border border-border-subtle bg-surface-raised p-4"
    >
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="font-display text-xl font-headline tracking-tight text-ink-primary">
          Saved screening answers
        </h2>
        {data && data.length > 0 ? (
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
            Clear all
          </Button>
        ) : null}
      </header>
      <p className="mb-3 text-sm text-ink-secondary">
        Answers Vina remembered from past Easy Apply runs. They are reused for
        matching questions on future applications. Read-only here — to change
        an answer, forget it and the next apply will prompt you again.
      </p>
      {isLoading ? <p className="text-sm text-ink-muted">Loading…</p> : null}
      {!isLoading && data && data.length === 0 ? (
        <p className="text-sm text-ink-muted">No saved answers yet.</p>
      ) : null}
      {data && data.length > 0 ? (
        <ul className="divide-y divide-border-subtle">
          {data.map((a) => (
            <li
              key={a.id}
              className="flex items-start justify-between gap-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink-primary">
                  {a.label}
                </p>
                <p className="truncate text-sm text-ink-secondary">{a.value}</p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => forget.mutate(a.key)}
                disabled={forget.isPending}
              >
                Forget
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {confirming ? (
        <div className="mt-3 rounded-md border border-warning bg-warning/10 p-3 text-sm">
          <p className="mb-2">
            Clear all saved answers? Vina will prompt you again the next time
            it sees each question.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => clearAll.mutate()}
              disabled={clearAll.isPending}
            >
              Confirm
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
