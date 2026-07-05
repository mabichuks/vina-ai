import { useState } from 'react';
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

const PAGE_SIZE = 10;

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

  const [sort, setSort] = useState<'score' | 'date'>('score');
  const [applyMethod, setApplyMethod] = useState<'' | 'auto' | 'manual'>('');
  const [siteId, setSiteId] = useState<'' | 'linkedin' | 'indeed' | 'google'>('');

  const [page, setPage] = useState(1);
  // Filter changes re-anchor to page 1 — page 7 of a different filter set is
  // meaningless. React's adjust-state-during-render pattern: compare a derived
  // key; if it changed, reset page synchronously in this render cycle instead
  // of scheduling an effect that would cause a phantom extra fetch.
  const filterKey = `${tab}:${minScore}:${sort}:${applyMethod}:${siteId}`;
  const [prevKey, setPrevKey] = useState(filterKey);
  if (prevKey !== filterKey) {
    setPrevKey(filterKey);
    setPage(1);
  }

  const jobs = useJobsPage({
    status: STATUS_FILTER_FOR_TAB[tab],
    ...(tab === 'new' && { min_score: minScore }),
    ...(applyMethod && { apply_method: applyMethod }),
    ...(siteId && { site_id: siteId }),
    sort,
    page,
    page_size: PAGE_SIZE,
  });

  // Clamp page to the last real page when the total shrinks under the current
  // filter (e.g. the user skips/applies the last job on the last page — the
  // server returns items:[], total > 0, and page > totalPages). Without this
  // clamp the UI shows an empty state with no pagination controls.
  const totalPages = Math.max(1, Math.ceil(jobs.total / PAGE_SIZE));
  if (!jobs.isLoading && jobs.total > 0 && page > totalPages) {
    setPage(totalPages);
  }

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

      <div className="flex flex-wrap items-center gap-3">
        <ControlSelect
          label="Sort"
          value={sort}
          onChange={(v) => setSort(v as 'score' | 'date')}
          options={[
            { value: 'score', label: 'Best match' },
            { value: 'date', label: 'Newest' },
          ]}
        />
        <ControlSelect
          label="Apply type"
          value={applyMethod}
          onChange={(v) => setApplyMethod(v as '' | 'auto' | 'manual')}
          options={[
            { value: '', label: 'All' },
            { value: 'auto', label: 'Easy Apply' },
            { value: 'manual', label: 'External' },
          ]}
        />
        <ControlSelect
          label="Source"
          value={siteId}
          onChange={(v) => setSiteId(v as '' | 'linkedin' | 'indeed' | 'google')}
          options={[
            { value: '', label: 'All sources' },
            { value: 'linkedin', label: 'LinkedIn' },
            { value: 'google', label: 'Google Jobs' },
            { value: 'indeed', label: 'Indeed' },
          ]}
        />
      </div>

      {jobs.isLoading ? (
        <p className="text-sm text-ink-secondary">Loading…</p>
      ) : jobs.items.length === 0 ? (
        <p className="text-sm text-ink-secondary">
          {applyMethod || siteId
            ? 'No jobs match the current filters.'
            : tab === 'new'
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

interface ControlSelectProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}

function ControlSelect({ label, value, onChange, options }: ControlSelectProps): JSX.Element {
  return (
    <label className="flex items-center gap-2">
      <span className="font-mono text-2xs uppercase tracking-wide text-ink-secondary">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-border-default bg-surface-sunken px-2 py-1.5 text-sm text-ink-primary outline-none focus:border-accent"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
