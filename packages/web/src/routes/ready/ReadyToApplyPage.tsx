import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Application, Job } from '@vina/shared';
import {
  tailoredCoverLetterUrl,
  tailoredCvUrl,
  useApplications,
  useJobs,
  useMarkApplied,
  useSkipApplication,
} from '../../api/resources.js';
import { downloadAuthed } from '../../api/client.js';
import { useUiStore } from '../../store/ui-store.js';
import { Button } from '../../components/ui/button.js';

export function ReadyToApplyPage(): JSX.Element {
  const applications = useApplications();
  // Pull all worklist jobs once and join client-side. The job list is bounded
  // (page_size cap) and avoids an N+1 fetch.
  const jobs = useJobs({ page_size: 100 });
  const jobsById = useMemo(() => {
    const m = new Map<string, Job>();
    for (const j of jobs.data) m.set(j.id, j);
    return m;
  }, [jobs.data]);

  const markApplied = useMarkApplied();
  const skip = useSkipApplication();
  const pushToast = useUiStore((s) => s.pushToast);

  const downloadOrToast = async (path: string, filename: string): Promise<void> => {
    try {
      await downloadAuthed(path, filename);
    } catch (err) {
      pushToast({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  if (applications.isLoading) {
    return <p className="p-6 text-sm text-ink-secondary">Loading…</p>;
  }

  if (applications.data.length === 0) {
    return (
      <section className="space-y-4">
        <header>
          <h1 className="font-display text-3xl font-headline tracking-tight text-ink-primary">
            Ready to apply
          </h1>
          <p className="mt-1 text-sm text-ink-secondary">
            Tailored materials land here after Vina scores a manual-apply job.
          </p>
        </header>
        <div className="rounded-md border border-border-subtle bg-surface-raised p-6 text-sm text-ink-secondary">
          No applications waiting. Open{' '}
          <Link to="/jobs?status=scored" className="underline">
            scored jobs
          </Link>{' '}
          and click <span className="font-medium text-ink-primary">Prepare materials</span> to
          generate a tailored CV.
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl font-headline tracking-tight text-ink-primary">
            Ready to apply
          </h1>
          <p className="mt-1 text-sm text-ink-secondary">
            {applications.data.length} application
            {applications.data.length === 1 ? '' : 's'} waiting for you.
          </p>
        </div>
      </header>
      <ul className="space-y-3">
        {applications.data.map((app) => (
          <li key={app.id}>
            <ApplicationCard
              application={app}
              job={jobsById.get(app.job_id) ?? null}
              onDownload={downloadOrToast}
              onMarkApplied={async (id, notes) => {
                try {
                  await markApplied.mutate(id, notes);
                  pushToast({ kind: 'info', message: 'Marked as applied.' });
                } catch (err) {
                  pushToast({
                    kind: 'error',
                    message: err instanceof Error ? err.message : String(err),
                  });
                }
              }}
              onSkip={async (id, reason) => {
                try {
                  await skip.mutate(id, reason);
                  pushToast({ kind: 'info', message: 'Skipped.' });
                } catch (err) {
                  pushToast({
                    kind: 'error',
                    message: err instanceof Error ? err.message : String(err),
                  });
                }
              }}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

interface CardProps {
  application: Application;
  job: Job | null;
  onDownload: (path: string, filename: string) => Promise<void>;
  onMarkApplied: (id: string, notes?: string) => void;
  onSkip: (id: string, reason?: string) => void;
}

function ApplicationCard({
  application,
  job,
  onDownload,
  onMarkApplied,
  onSkip,
}: CardProps): JSX.Element {
  const [markOpen, setMarkOpen] = useState(false);
  const [skipOpen, setSkipOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');

  const externalUrl = job?.external_apply_url ?? job?.url ?? null;
  const applyLabel = job?.original_source ? `Apply on ${job.original_source}` : 'Apply externally';
  // Defensive filename: if the server response 404s (e.g. mid-deploy), the
  // browser would otherwise save the JSON error body using the URL path as
  // the filename. Pin a sensible name so it's always *.docx.
  const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
  const cvFilename = `${safeName(job?.company ?? 'job')}-${safeName(job?.title ?? 'tailored')}-cv.docx`;
  const coverFilename = `${safeName(job?.company ?? 'job')}-${safeName(job?.title ?? 'tailored')}-cover.docx`;

  return (
    <article className="rounded-lg border border-border-subtle bg-surface-raised p-4">
      <header className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-medium text-ink-primary">{job?.title ?? 'Job'}</span>
        <span className="text-ink-muted">·</span>
        <span className="text-ink-secondary">{job?.company ?? ''}</span>
        {job?.location && (
          <>
            <span className="text-ink-muted">·</span>
            <span className="text-ink-secondary">{job.location}</span>
          </>
        )}
      </header>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full bg-warning-soft px-2 py-0.5 text-warning">External</span>
        {job?.match_score != null && (
          <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-ink-secondary">
            Score {job.match_score}
          </span>
        )}
      </div>
      <p className="mt-2 text-sm text-ink-secondary">
        Tailored CV ready
        {application.tailored_cover_letter_path ? ' · Cover letter ready' : ''}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void onDownload(tailoredCvUrl(application.id), cvFilename)}
          className="rounded-md border border-border-subtle bg-surface-sunken px-3 py-1 text-sm text-ink-primary hover:bg-surface-base"
        >
          Download CV
        </button>
        {application.tailored_cover_letter_path && (
          <button
            type="button"
            onClick={() =>
              void onDownload(tailoredCoverLetterUrl(application.id), coverFilename)
            }
            className="rounded-md border border-border-subtle bg-surface-sunken px-3 py-1 text-sm text-ink-primary hover:bg-surface-base"
          >
            Download cover letter
          </button>
        )}
        {externalUrl && (
          <a
            href={externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-border-subtle bg-surface-sunken px-3 py-1 text-sm text-ink-primary hover:bg-surface-base"
          >
            {applyLabel}
          </a>
        )}
        <Button size="sm" onClick={() => setMarkOpen(true)}>
          Mark applied
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setSkipOpen(true)}>
          Skip
        </Button>
      </div>

      {markOpen && (
        <div className="mt-3 space-y-2 rounded-md border border-border-subtle bg-surface-sunken p-3">
          <label className="block text-xs text-ink-muted">
            Notes (optional)
            <textarea
              aria-label="Notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. applied via Greenhouse"
              className="mt-1 w-full rounded-md border border-border-subtle bg-surface-raised px-2 py-1 text-ink-primary"
            />
          </label>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                onMarkApplied(application.id, notes.trim() || undefined);
                setMarkOpen(false);
                setNotes('');
              }}
            >
              Confirm
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setMarkOpen(false);
                setNotes('');
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {skipOpen && (
        <div className="mt-3 space-y-2 rounded-md border border-border-subtle bg-surface-sunken p-3">
          <label className="block text-xs text-ink-muted">
            Reason (optional)
            <textarea
              aria-label="Skip reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. role mismatch"
              className="mt-1 w-full rounded-md border border-border-subtle bg-surface-raised px-2 py-1 text-ink-primary"
            />
          </label>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                onSkip(application.id, reason.trim() || undefined);
                setSkipOpen(false);
                setReason('');
              }}
            >
              Confirm skip
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSkipOpen(false);
                setReason('');
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}
