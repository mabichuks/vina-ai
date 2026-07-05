import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import { Button } from '../../components/ui/button.js';

interface RecentApply {
  application_id: string;
  title: string;
  company: string;
  status: string;
  submitted_at: string | null;
  updated_at: string;
}

interface Summary {
  submitted_today: number;
  day_bucket: string;
  circuit_breaker_tripped: boolean;
  consecutive_failures: number;
  easy_apply_mode: 'autonomous' | 'manual';
  daily_cap: number;
  recent: RecentApply[];
}

// Raw fetch() here once caused a permanent "Loading…" card: the API needs a
// bearer token, so every unauthenticated call 401'd and the query never
// resolved. Always go through the shared `api` client — it attaches the
// token and re-bootstraps it after a daemon restart.
async function fetchSummary(): Promise<Summary> {
  return api<Summary>('/api/dashboard/easy-apply');
}

async function patchMode(mode: 'autonomous' | 'manual'): Promise<void> {
  await api('/api/settings', { method: 'PATCH', body: { easy_apply_mode: mode } });
}

export function EasyApplyCard(): JSX.Element {
  const qc = useQueryClient();
  const { data, isError } = useQuery({
    queryKey: ['dashboard', 'easy-apply'],
    queryFn: fetchSummary,
    refetchInterval: 30_000,
  });
  const pause = useMutation({
    mutationFn: () => patchMode('manual'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['dashboard', 'easy-apply'] });
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  // Distinguish a failed query from a pending one — a card stuck on
  // "Loading…" hides real errors from the user.
  if (isError) {
    return (
      <section className="rounded-lg border border-border-subtle bg-surface-raised p-4">
        <p className="text-sm text-danger">Couldn’t load Easy Apply activity.</p>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="rounded-lg border border-border-subtle bg-surface-raised p-4">
        <p className="text-sm text-ink-muted">Loading…</p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border-subtle bg-surface-raised p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="font-display text-xl font-headline tracking-tight text-ink-primary">
          Easy Apply (last 24h)
        </h2>
        <span className="text-xs text-ink-muted">{data.day_bucket}</span>
      </header>
      <div className="flex items-baseline gap-3">
        <span className="text-2xl font-semibold text-ink-primary">
          {data.submitted_today} / {data.daily_cap}
        </span>
        <span className="text-sm text-ink-secondary">submitted today</span>
      </div>
      {data.circuit_breaker_tripped ? (
        <p className="mt-2 rounded bg-danger/10 p-2 text-sm text-danger">
          Circuit breaker tripped after {data.consecutive_failures} consecutive
          failures — mode flipped to manual.
        </p>
      ) : null}
      {data.easy_apply_mode === 'autonomous' && !data.circuit_breaker_tripped ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => pause.mutate()}
          disabled={pause.isPending}
        >
          Pause autonomous now
        </Button>
      ) : null}
      {data.recent.length > 0 ? (
        <ul className="mt-4 divide-y divide-border-subtle text-sm">
          {data.recent.map((r) => (
            <li
              key={r.application_id}
              className="flex items-baseline justify-between py-1.5"
            >
              <span className="min-w-0 flex-1 truncate">
                <a
                  className="text-ink-primary hover:underline"
                  href={`/applications#${r.application_id}`}
                >
                  {r.title}
                </a>
                <span className="ml-1 text-ink-muted">· {r.company}</span>
              </span>
              <span className="ml-2 shrink-0 text-xs text-ink-secondary">
                {r.status}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
