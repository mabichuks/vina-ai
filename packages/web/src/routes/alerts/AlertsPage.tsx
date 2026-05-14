import { Link } from 'react-router-dom';
import type { Alert } from '@vina/shared';
import {
  useAlerts,
  useDismissAlert,
  useResolveAlert,
} from '../../api/resources.js';
import { Button } from '../../components/ui/button.js';

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
  const resolve = useResolveAlert();
  const dismiss = useDismissAlert();

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
          {alerts.data.map((alert) => {
            const href = reconnectHref(alert);
            return (
              <li
                key={alert.id}
                className="rounded-lg border border-border-subtle bg-surface-raised p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${severityBadge(alert)}`}
                      >
                        {alert.severity.replace('_', ' ')}
                      </span>
                      <h2 className="font-medium text-ink-primary">{alert.title}</h2>
                    </div>
                    <p className="mt-1 text-sm text-ink-secondary">{alert.description}</p>
                  </div>
                  <p className="shrink-0 text-xs text-ink-muted">
                    {new Date(alert.created_at).toLocaleString()}
                  </p>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
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
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
