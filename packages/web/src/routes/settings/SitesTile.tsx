import { useState } from 'react';
import {
  useDisconnectLinkedIn,
  useLinkedInStatus,
  useStartLinkedInConnect,
  useGoogleJobsStatus,
  useValidateSerpapiKey,
  useDisconnectGoogleJobs,
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

function GoogleJobsRow(): JSX.Element {
  const status = useGoogleJobsStatus({ pollMs: 5000 });
  const validate = useValidateSerpapiKey();
  const disconnect = useDisconnectGoogleJobs();
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onSave = async (): Promise<void> => {
    setError(null);
    const res = await validate.mutate(key);
    if (res.ok) {
      setKey('');
      setEditing(false);
    } else {
      setError(res.detail ?? res.reason ?? 'Validation failed');
    }
  };

  // Treat null data (still loading) as not_configured so we don't flash empty buttons
  const state = status.data?.state ?? 'not_configured';

  const label = (() => {
    switch (state) {
      case 'active':
        return (
          <span className="text-success">
            ● Active
            {status.data?.last_search_at && (
              <span className="ml-2 text-ink-muted">
                · last search {new Date(status.data.last_search_at).toLocaleString()}
              </span>
            )}
          </span>
        );
      case 'paused':
        return <span className="text-ink-muted">⏸ Paused</span>;
      case 'key_invalid':
        return <span className="text-warning">⚠ Key invalid</span>;
      case 'quota_exhausted':
        return <span className="text-warning">⚠ Quota exhausted</span>;
      default:
        return <span className="text-ink-muted">○ Not configured</span>;
    }
  })();

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium text-ink-primary">Google Jobs</p>
          <p className="text-xs text-ink-secondary">{label}</p>
        </div>
        <div className="flex gap-2">
          {state === 'not_configured' && (
            <Button size="sm" onClick={() => setEditing(true)}>
              Add SerpAPI key
            </Button>
          )}
          {(state === 'active' || state === 'paused') && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                Edit key
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void disconnect.mutate()}
                disabled={disconnect.isPending}
              >
                Disconnect
              </Button>
            </>
          )}
          {state === 'key_invalid' && (
            <Button size="sm" onClick={() => setEditing(true)}>
              Update key
            </Button>
          )}
          {state === 'quota_exhausted' && (
            <Button variant="ghost" size="sm" onClick={() => void disconnect.mutate()}>
              Disconnect
            </Button>
          )}
        </div>
      </div>
      {editing && (
        <div className="space-y-2 rounded-md border border-border-subtle bg-surface-sunken p-3">
          <label className="block text-xs text-ink-muted">
            SerpAPI key
            <input
              type="password"
              autoComplete="off"
              aria-label="SerpAPI key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className="mt-1 w-full rounded-md border border-border-subtle bg-surface-raised px-2 py-1 text-ink-primary"
            />
          </label>
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => void onSave()}
              disabled={validate.isPending || key.trim().length === 0}
            >
              {validate.isPending ? 'Saving…' : 'Save'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(false);
                setKey('');
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
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
        <GoogleJobsRow />
      </ul>
    </section>
  );
}
