import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ApplicationListItem, ApplicationStatus } from '@vina/shared';
import { useApplications, useRetryApplication, tailoredCvUrl } from '../../api/resources.js';
import { useUiStore } from '../../store/ui-store.js';
import { Button } from '../../components/ui/button.js';

const STATUS_STYLE: Record<ApplicationStatus, string> = {
  queued: 'bg-surface-sunken text-ink-secondary',
  applying: 'bg-info/10 text-info',
  awaiting_user: 'bg-warning/10 text-warning',
  awaiting_approval: 'bg-warning/10 text-warning',
  ready_for_manual_apply: 'bg-accent/10 text-accent',
  submitted: 'bg-success/10 text-success',
  applied_manually: 'bg-success/10 text-success',
  failed: 'bg-danger/10 text-danger',
  skipped: 'bg-surface-sunken text-ink-muted',
};

function StatusBadge({ status }: { status: ApplicationStatus }): JSX.Element {
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${
        STATUS_STYLE[status] ?? 'bg-surface-sunken text-ink-secondary'
      }`}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const seconds = Math.round((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

export interface ApplicationGroup<T extends { job_id: string; started_at: string }> {
  latest: T;
  history: T[]; // older attempts, newest first
}

/**
 * One group per job: the latest attempt is the representative row; older
 * attempts (retries create one application per attempt) become expandable
 * history. Rows arrive in any order — sort within group by started_at desc.
 */
export function groupByJob<T extends { job_id: string; started_at: string }>(
  rows: T[],
): ApplicationGroup<T>[] {
  const byJob = new Map<string, T[]>();
  for (const row of rows) {
    const list = byJob.get(row.job_id) ?? [];
    list.push(row);
    byJob.set(row.job_id, list);
  }
  return [...byJob.values()]
    .map((list) => {
      const sorted = [...list].sort(
        (a, b) => Date.parse(b.started_at) - Date.parse(a.started_at),
      );
      return { latest: sorted[0]!, history: sorted.slice(1) };
    })
    .sort(
      (a, b) => Date.parse(b.latest.started_at) - Date.parse(a.latest.started_at),
    );
}

export function ApplicationsPage(): JSX.Element {
  const { data, isLoading } = useApplications({
    status: 'all',
    refetchIntervalMs: 5_000,
  });

  // Newest first by started_at (already the repo's default order, but
  // be explicit so the page is stable across refetches).
  const rows = [...data].sort((a, b) =>
    b.started_at.localeCompare(a.started_at),
  );

  const groups = groupByJob(rows);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (jobId: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) {
        next.delete(jobId);
      } else {
        next.add(jobId);
      }
      return next;
    });
  };

  return (
    <section className="space-y-4">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-headline tracking-tight text-ink-primary">
            Applications
          </h1>
          <p className="mt-1 text-sm text-ink-secondary">
            Every in-flight and recent application. Status updates every 5
            seconds while the worker runs.
          </p>
        </div>
        <Link
          to="/alerts"
          className="text-sm text-accent underline-offset-4 hover:underline"
        >
          Open alerts →
        </Link>
      </header>

      {isLoading ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-muted">
          No applications yet. They appear here as soon as the scoring or
          apply task queues something.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface-raised">
          <table className="w-full text-sm">
            <thead className="border-b border-border-subtle bg-surface-sunken text-left text-xs uppercase tracking-wider text-ink-muted">
              <tr>
                <th className="px-3 py-2">Job</th>
                <th className="px-3 py-2">Method</th>
                <th className="px-3 py-2">Score</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Started</th>
                <th className="px-3 py-2">Tailored</th>
                <th className="px-3 py-2">CV</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <Fragment key={group.latest.id}>
                  <ApplicationRow
                    row={group.latest}
                    isRepresentative={true}
                    historyCount={group.history.length}
                    isExpanded={expanded.has(group.latest.job_id)}
                    onToggle={() => toggle(group.latest.job_id)}
                  />
                  {expanded.has(group.latest.job_id) &&
                    group.history.map((histRow) => (
                      <ApplicationRow
                        key={histRow.id}
                        row={histRow}
                        isRepresentative={false}
                        historyCount={0}
                        isExpanded={false}
                        onToggle={() => undefined}
                      />
                    ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

interface ApplicationRowProps {
  row: ApplicationListItem;
  isRepresentative: boolean;
  historyCount: number;
  isExpanded: boolean;
  onToggle: () => void;
}

function ApplicationRow({
  row,
  isRepresentative,
  historyCount,
  isExpanded,
  onToggle,
}: ApplicationRowProps): JSX.Element {
  const cvHref = row.tailored_cv_path
    ? `${tailoredCvUrl(row.id)}?format=docx`
    : null;
  const pdfHref = row.tailored_cv_pdf_path
    ? `${tailoredCvUrl(row.id)}?format=pdf`
    : null;
  const retry = useRetryApplication();
  const pushToast = useUiStore((s) => s.pushToast);

  return (
    <tr
      className={`border-b border-border-subtle last:border-0${
        isRepresentative ? '' : ' opacity-60'
      }`}
    >
      <td className="px-3 py-2 align-top">
        {row.job ? (
          <a
            href={row.job.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-ink-primary underline-offset-2 hover:underline"
          >
            <span className="block font-medium">{row.job.title}</span>
            <span className="block text-xs text-ink-secondary">
              {row.job.company || '—'}
              {row.job.location ? ` · ${row.job.location}` : ''}
            </span>
          </a>
        ) : (
          <span className="text-ink-muted">job missing</span>
        )}
        {isRepresentative && historyCount > 0 && (
          <button
            type="button"
            className="ml-2 rounded-pill bg-surface-sunken px-2 py-0.5 font-mono text-2xs text-ink-secondary hover:text-ink-primary"
            aria-expanded={isExpanded}
            onClick={onToggle}
          >
            {'×'}{historyCount + 1} attempts
          </button>
        )}
      </td>
      <td className="px-3 py-2 align-top text-xs text-ink-secondary">
        {row.apply_method}
      </td>
      <td className="px-3 py-2 align-top text-xs text-ink-secondary">
        {row.job?.match_score ?? '—'}
      </td>
      <td className="px-3 py-2 align-top">
        <StatusBadge status={row.status} />
        {row.failure_reason ? (
          <div className="mt-1 text-xs text-ink-muted">{row.failure_reason}</div>
        ) : null}
      </td>
      <td className="px-3 py-2 align-top text-xs text-ink-secondary" title={row.started_at}>
        {formatRelative(row.started_at)}
      </td>
      <td className="px-3 py-2 align-top text-xs text-ink-secondary" title={row.tailored_at ?? ''}>
        {row.tailored_at ? formatRelative(row.tailored_at) : '—'}
      </td>
      <td className="px-3 py-2 align-top text-xs">
        {cvHref ? (
          <a
            href={cvHref}
            className="text-accent underline-offset-2 hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            DOCX
          </a>
        ) : null}
        {cvHref && pdfHref ? <span className="text-ink-muted"> · </span> : null}
        {pdfHref ? (
          <a
            href={pdfHref}
            className="text-accent underline-offset-2 hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            PDF
          </a>
        ) : null}
        {!cvHref && !pdfHref ? <span className="text-ink-muted">—</span> : null}
      </td>
      <td className="px-3 py-2 align-top">
        {isRepresentative &&
          row.apply_method === 'auto' &&
          (row.status === 'awaiting_user' || row.status === 'failed') && (
            <Button
              variant="ghost"
              size="sm"
              disabled={retry.isPending}
              onClick={() =>
                void retry
                  .mutate(row.id)
                  .then(() => pushToast({ kind: 'success', message: 'Retry queued.' }))
                  .catch((err) =>
                    pushToast({
                      kind: 'error',
                      message: err instanceof Error ? err.message : String(err),
                    }),
                  )
              }
            >
              Retry
            </Button>
          )}
      </td>
    </tr>
  );
}
