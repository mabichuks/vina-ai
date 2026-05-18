import type { Job } from '@vina/shared';
import { Button } from '../../components/ui/button.js';
import { LoadingDots } from '../../components/ui/loading-dots.js';

function applyLabel(job: Job): string {
  if (job.apply_method === 'auto') return 'Apply on LinkedIn';
  if (job.original_source) return `Apply on ${job.original_source.replace(/^via\s+/i, '')}`;
  return 'Apply externally';
}

interface Props {
  job: Job;
  variant: 'new' | 'applied' | 'skipped';
  onApply: () => void;
  onMarkApplied: () => void;
  onSkip: () => void;
  onReopen: () => void;
  /** Manual-apply pipeline: kicks off tailoring for this job. */
  onPrepare?: () => void;
  /** True once an active application exists for this job. */
  preparing?: boolean;
  /** True once tailoring has finished and the user can go to /ready. */
  ready?: boolean;
}

function applyHref(job: Job): string {
  return job.apply_method === 'auto' ? job.url : (job.external_apply_url ?? job.url);
}

export function JobCard({
  job,
  variant,
  onApply,
  onMarkApplied,
  onSkip,
  onReopen,
  onPrepare,
  preparing,
  ready,
}: Props): JSX.Element {
  const isExternal = job.apply_method === 'manual';
  return (
    <article className="rounded-lg border border-border-subtle bg-surface-raised p-4">
      <header className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-medium text-ink-primary">{job.title}</span>
        <span className="text-ink-muted">·</span>
        <span className="text-ink-secondary">{job.company}</span>
        {job.location && (
          <>
            <span className="text-ink-muted">·</span>
            <span className="text-ink-secondary">{job.location}</span>
          </>
        )}
        {job.original_source && (
          <p className="basis-full text-xs text-ink-muted">{job.original_source}</p>
        )}
      </header>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span
          className={`rounded-full px-2 py-0.5 ${
            isExternal ? 'bg-warning-soft text-warning' : 'bg-success-soft text-success'
          }`}
        >
          {isExternal ? 'External' : 'Easy Apply'}
        </span>
        {job.match_score !== null ? (
          <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-ink-secondary">
            Score {job.match_score}
          </span>
        ) : (
          // Pinned-to-bottom worklist row that's still being scored. The
          // pulse hints that work is in progress without needing a spinner.
          <span className="inline-flex items-center gap-1.5 rounded-full bg-info-soft px-2 py-0.5 text-info">
            Scoring
            <LoadingDots />
          </span>
        )}
        {job.salary_text && <span className="text-ink-muted">{job.salary_text}</span>}
      </div>
      {job.description && (
        <p className="mt-2 line-clamp-2 text-sm text-ink-secondary">{job.description}</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {variant === 'new' ? (
          <>
            {/* Prepare materials is the *recommended* primary action for
                manual jobs, but the user can always bypass it and apply
                directly with their default CV. Apply stays visible as a
                secondary action for that path. */}
            {isExternal && onPrepare && !preparing && !ready && (
              <Button variant="default" size="sm" onClick={onPrepare}>
                Prepare materials
              </Button>
            )}
            {isExternal && preparing && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-info-soft px-2 py-0.5 text-xs text-info">
                Tailoring
                <LoadingDots />
              </span>
            )}
            {isExternal && ready && (
              <a
                href="/ready"
                className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-success-soft px-3 py-1 text-sm text-success"
              >
                Ready to apply →
              </a>
            )}
            <Button
              variant={isExternal && onPrepare && !preparing && !ready ? 'ghost' : 'default'}
              size="sm"
              onClick={onApply}
            >
              {applyLabel(job)}
            </Button>
            <Button variant="ghost" size="sm" onClick={onMarkApplied}>
              Mark applied
            </Button>
            <Button variant="ghost" size="sm" onClick={onSkip}>
              Skip
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" onClick={onReopen}>
            Reopen
          </Button>
        )}
      </div>
    </article>
  );
}

export { applyHref };
