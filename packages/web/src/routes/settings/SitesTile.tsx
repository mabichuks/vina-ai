import {
  useDisconnectLinkedIn,
  useLinkedInStatus,
  useStartLinkedInConnect,
} from '../../api/resources.js';
import { Button } from '../../components/ui/button.js';

function StatusDot({
  status,
}: {
  status: { connected: boolean; error: string | null } | null;
}): JSX.Element {
  if (status?.connected) {
    return <span className="text-success">● Connected</span>;
  }
  if (status?.error) {
    return <span className="text-warning">⚠ Session expired</span>;
  }
  return <span className="text-ink-muted">○ Not connected</span>;
}

export function SitesTile(): JSX.Element {
  const linkedin = useLinkedInStatus({ pollMs: 3000 });
  const start = useStartLinkedInConnect();
  const disconnect = useDisconnectLinkedIn();

  return (
    <section
      id="sites"
      className="rounded-lg border border-border-subtle bg-surface-raised p-4"
    >
      <h2 className="font-display text-xl font-headline tracking-tight text-ink-primary">
        Job sources
      </h2>
      <p className="mt-1 text-sm text-ink-secondary">
        Vina searches the sources you connect here.
      </p>
      <ul className="mt-4 divide-y divide-border-subtle">
        <li className="flex items-center justify-between py-3">
          <div>
            <p className="font-medium text-ink-primary">LinkedIn</p>
            <p className="text-xs text-ink-secondary">
              <StatusDot status={linkedin.data} />
            </p>
          </div>
          <div className="flex gap-2">
            {linkedin.data?.connected ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => disconnect.mutate()}
                disabled={disconnect.isPending}
              >
                Disconnect
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => start.mutate()}
                disabled={start.isPending || linkedin.data?.attempting}
              >
                {linkedin.data?.attempting ? 'Connecting…' : 'Connect'}
              </Button>
            )}
          </div>
        </li>
        <li className="flex items-center justify-between py-3">
          <p className="font-medium text-ink-secondary">Indeed</p>
          <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted">
            Coming soon
          </span>
        </li>
        <li className="flex items-center justify-between py-3">
          <p className="font-medium text-ink-secondary">Google Jobs</p>
          <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted">
            Coming soon
          </span>
        </li>
      </ul>
    </section>
  );
}
