import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { JobStatus } from '@vina/shared';
import {
  useApplications,
  useAutoApplyJob,
  useJobsPage,
  useLinkedInStatus,
  useMarkJobApplied,
  usePrepareJob,
  useReopenJob,
  useSearchPreferences,
  useSkipJob,
} from '../../api/resources.js';
import { PaginationBar } from '../../components/ui/pagination-bar.js';
import { SearchActivityPanel } from '../../components/search/SearchActivityPanel.js';
import { SearchNowButton } from '../../components/search/SearchNowButton.js';
import { useUiStore } from '../../store/ui-store.js';
import { applyHref, JobCard } from './JobCard.js';

type Tab = 'new' | 'applied' | 'skipped';

const TAB_LABELS: Record<Tab, string> = {
  new: 'New',
  applied: 'Applied',
  skipped: 'Skipped',
};

// `new` tab is the worklist — includes still-being-scored rows so the user
// sees jobs stream in immediately as "Scoring…" placeholders, rather than
// waiting for the whole search-then-score cycle to complete before anything
// becomes visible.
const STATUS_FILTER_FOR_TAB: Record<Tab, JobStatus | JobStatus[]> = {
  new: ['new', 'scored'],
  applied: 'applied_manually',
  skipped: 'skipped',
};

export function JobsPage(): JSX.Element {
  const [tab, setTab] = useState<Tab>('new');
  const prefs = useSearchPreferences();
  const linkedin = useLinkedInStatus({ pollMs: 5000 });
  const minScore = prefs.data?.score_threshold ?? 70;

  const PAGE_SIZE = 25;
  const [page, setPage] = useState(1);
  // Filter changes re-anchor to page 1 — page 7 of a different filter set
  // is meaningless. The setState-in-effect pattern is intentional here: we
  // need a synchronous reset whenever the filter changes, not a derived value.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPage(1);
  }, [tab, minScore]);

  const jobs = useJobsPage({
    status: STATUS_FILTER_FOR_TAB[tab],
    ...(tab === 'new' && { min_score: minScore }),
    page,
    page_size: PAGE_SIZE,
  });

  const markApplied = useMarkJobApplied();
  const skip = useSkipJob();
  const reopen = useReopenJob();
  const prepare = usePrepareJob();
  const autoApply = useAutoApplyJob();
  const pushToast = useUiStore((s) => s.pushToast);

  // For each manual-apply job, surface "Tailoring…" or "Ready to apply" badges
  // off of the application status. One query covers both the in-flight and
  // ready states (status filter widens to 'queued' so newly-enqueued tailoring
  // shows up immediately; ready_for_manual_apply is the terminal pre-apply
  // state).
  const tailoringApps = useApplications({ status: 'queued', pageSize: 100 });
  const readyApps = useApplications({ status: 'ready_for_manual_apply', pageSize: 100 });
  const preparingJobIds = new Set<string>(tailoringApps.data.map((a) => a.job_id));
  const readyJobIds = new Set<string>(readyApps.data.map((a) => a.job_id));

  const sessionExpired =
    linkedin.data !== null && !linkedin.data.connected && linkedin.data.error !== null;

  return (
    <section className="space-y-4">
      {sessionExpired && (
        <div className="rounded-md border border-warning bg-warning-soft px-4 py-3 text-sm text-warning">
          LinkedIn session expired.{' '}
          <Link to="/settings#sites" className="underline">
            Reconnect
          </Link>{' '}
          to resume searches.
        </div>
      )}

      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl font-headline tracking-tight text-ink-primary">
            Jobs
          </h1>
          <p className="mt-1 text-sm text-ink-secondary">
            {linkedin.data?.last_success_at
              ? `Last connected ${new Date(linkedin.data.last_success_at).toLocaleString()}`
              : 'Connect LinkedIn from Settings to begin.'}
          </p>
        </div>
        <SearchNowButton />
      </header>

      <SearchActivityPanel />

      <nav className="flex gap-2 border-b border-border-subtle">
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`-mb-px px-3 py-2 text-sm transition ${
              tab === t
                ? 'border-b-2 border-accent text-ink-primary'
                : 'text-ink-secondary hover:text-ink-primary'
            }`}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </nav>

      {jobs.isLoading ? (
        <p className="text-sm text-ink-secondary">Loading…</p>
      ) : jobs.items.length === 0 ? (
        <p className="text-sm text-ink-secondary">
          {tab === 'new'
            ? 'No new jobs yet. Try Search now once LinkedIn is connected.'
            : tab === 'applied'
              ? 'You haven’t marked anything applied yet.'
              : 'Nothing skipped.'}
        </p>
      ) : (
        <ul className="space-y-3">
          {jobs.items.map((job) => (
            <li key={job.id}>
              <JobCard
                job={job}
                variant={tab}
                preparing={preparingJobIds.has(job.id)}
                ready={readyJobIds.has(job.id)}
                onPrepare={async () => {
                  try {
                    await prepare.mutate(job.id);
                    pushToast({
                      kind: 'info',
                      message: 'Tailoring started. Watch the Ready to apply tab.',
                    });
                  } catch (err) {
                    pushToast({
                      kind: 'error',
                      message: err instanceof Error ? err.message : String(err),
                    });
                  }
                }}
                onApply={() => window.open(applyHref(job), '_blank', 'noreferrer')}
                onAutoApply={
                  job.apply_method === 'auto' && tab === 'new'
                    ? async () => {
                        try {
                          const r = await autoApply.mutate(job.id);
                          pushToast({
                            kind: r.deduped ? 'info' : 'success',
                            message: r.deduped
                              ? 'Already queued.'
                              : 'Auto-apply queued.',
                          });
                        } catch (err) {
                          pushToast({
                            kind: 'error',
                            message: err instanceof Error ? err.message : String(err),
                          });
                        }
                      }
                    : undefined
                }
                onMarkApplied={async () => {
                  await markApplied.mutate(job.id);
                  pushToast({ kind: 'success', message: 'Marked applied.' });
                }}
                onSkip={async () => {
                  await skip.mutate(job.id);
                  pushToast({ kind: 'info', message: 'Skipped.' });
                }}
                onReopen={async () => {
                  await reopen.mutate(job.id);
                  pushToast({ kind: 'info', message: 'Reopened.' });
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {!jobs.isLoading && (
        <PaginationBar
          page={page}
          pageSize={PAGE_SIZE}
          total={jobs.total}
          onPageChange={(p) => {
            setPage(p);
            window.scrollTo({ top: 0 });
          }}
        />
      )}
    </section>
  );
}
