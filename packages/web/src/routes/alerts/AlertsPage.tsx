import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Alert } from '@vina/shared';
import {
  tailoredCoverLetterUrl,
  tailoredCvUrl,
  useAlerts,
  useDismissAlert,
  useMarkApplied,
  useResolveAlert,
} from '../../api/resources.js';
import { downloadAuthed } from '../../api/client.js';
import { useUiStore } from '../../store/ui-store.js';
import { Button } from '../../components/ui/button.js';

interface ReadyAlertPayload {
  application_id?: string;
  job_id?: string;
  external_apply_url?: string;
  tailored_cv_path?: string;
  tailored_cover_letter_path?: string | null;
}

function parseReadyPayload(alert: Alert): ReadyAlertPayload | null {
  if (alert.kind !== 'ready_for_manual_apply' || !alert.payload) return null;
  try {
    return JSON.parse(alert.payload) as ReadyAlertPayload;
  } catch {
    return null;
  }
}

function reconnectHref(alert: Alert): string | null {
  if (alert.kind === 'linkedin_session_expired') return '/settings#sites';
  if (alert.kind === 'schedule_paused') return '/settings#sites';
  return null;
}

function severityBadge(alert: Alert): string {
  switch (alert.severity) {
    case 'error':
      return 'bg-danger-soft text-danger';
    case 'action_required':
      return 'bg-warning-soft text-warning';
    default:
      return 'bg-info-soft text-info';
  }
}

export function AlertsPage(): JSX.Element {
  const alerts = useAlerts();

  return (
    <section className="space-y-4">
      <h1 className="font-display text-3xl font-headline tracking-tight text-ink-primary">
        Alerts
      </h1>

      {alerts.isLoading ? (
        <p className="text-sm text-ink-secondary">Loading…</p>
      ) : alerts.data.length === 0 ? (
        <p className="text-sm text-ink-secondary">All clear.</p>
      ) : (
        <ul className="space-y-3">
          {alerts.data.map((alert) => (
            <li key={alert.id}>
              <AlertCard alert={alert} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AlertCard({ alert }: { alert: Alert }): JSX.Element {
  const resolve = useResolveAlert();
  const dismiss = useDismissAlert();
  const markApplied = useMarkApplied();
  const pushToast = useUiStore((s) => s.pushToast);
  const [expanded, setExpanded] = useState(false);

  const href = reconnectHref(alert);
  const ready = parseReadyPayload(alert);

  // Approximate threshold for "needs a View toggle" — keep cards predictable
  // in height without computing reflow. Anything over ~240 chars likely wraps
  // past the 3-line clamp anyway.
  const isLong = alert.description.length > 240;

  const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);

  const downloadCv = async (): Promise<void> => {
    if (!ready?.application_id) return;
    try {
      await downloadAuthed(
        tailoredCvUrl(ready.application_id),
        `${safeName(alert.title)}-cv.docx`,
      );
    } catch (err) {
      pushToast({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const downloadCover = async (): Promise<void> => {
    if (!ready?.application_id) return;
    try {
      await downloadAuthed(
        tailoredCoverLetterUrl(ready.application_id),
        `${safeName(alert.title)}-cover.docx`,
      );
    } catch (err) {
      pushToast({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <article className="overflow-hidden rounded-lg border border-border-subtle bg-surface-raised p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-xs ${severityBadge(alert)}`}>
              {alert.severity.replace('_', ' ')}
            </span>
            <h2 className="font-medium text-ink-primary">{alert.title}</h2>
          </div>
          <p
            className={`mt-1 whitespace-pre-wrap break-words text-sm text-ink-secondary ${
              expanded ? '' : 'line-clamp-3'
            }`}
          >
            {alert.description}
          </p>
          {isLong && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 text-xs text-ink-primary underline hover:no-underline"
            >
              {expanded ? 'Show less' : 'View full message'}
            </button>
          )}
        </div>
        <p className="shrink-0 whitespace-nowrap text-xs text-ink-muted">
          {new Date(alert.created_at).toLocaleString()}
        </p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {ready && ready.application_id && (
          <>
            <button
              type="button"
              onClick={() => void downloadCv()}
              className="rounded-md border border-border-subtle bg-surface-sunken px-3 py-1 text-sm text-ink-primary hover:bg-surface-base"
            >
              Download CV
            </button>
            {ready.tailored_cover_letter_path && (
              <button
                type="button"
                onClick={() => void downloadCover()}
                className="rounded-md border border-border-subtle bg-surface-sunken px-3 py-1 text-sm text-ink-primary hover:bg-surface-base"
              >
                Download cover letter
              </button>
            )}
            {ready.external_apply_url && (
              <a
                href={ready.external_apply_url}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-border-subtle bg-surface-sunken px-3 py-1 text-sm text-ink-primary hover:bg-surface-base"
              >
                Apply externally
              </a>
            )}
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await markApplied.mutate(ready.application_id!);
                  pushToast({ kind: 'info', message: 'Marked as applied.' });
                } catch (err) {
                  pushToast({
                    kind: 'error',
                    message: err instanceof Error ? err.message : String(err),
                  });
                }
              }}
            >
              Mark applied
            </Button>
          </>
        )}
        {href && (
          <Button asChild size="sm">
            <Link to={href}>Reconnect</Link>
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => resolve.mutate(alert.id)}>
          Resolve
        </Button>
        <Button variant="ghost" size="sm" onClick={() => dismiss.mutate(alert.id)}>
          Dismiss
        </Button>
      </div>
    </article>
  );
}
