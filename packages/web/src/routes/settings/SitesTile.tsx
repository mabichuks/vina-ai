import { useEffect, useState } from 'react';
import {
  useDisconnectGoogleJobs,
  useDisconnectLinkedIn,
  useLinkedInStatus,
  useSiteStatus,
  useStartLinkedInConnect,
  useToggleSite,
  useValidateSerpapiKey,
} from '../../api/resources.js';
import { Button } from '../../components/ui/button.js';
import { Switch } from '../../components/ui/switch.js';

function SiteToggle({ id, label }: { id: string; label: string }): JSX.Element {
  const status = useSiteStatus(id);
  const toggle = useToggleSite();
  const enabled = status.data?.enabled ?? false;
  const canToggle = (status.data?.has_credentials ?? false) && !toggle.isPending;
  return (
    <Switch
      aria-label={label}
      checked={enabled}
      disabled={!canToggle}
      onCheckedChange={(next) => void toggle.mutate(id, next)}
      title={status.data?.has_credentials ? undefined : 'Connect first.'}
    />
  );
}

function LinkedInRow(): JSX.Element {
  const status = useSiteStatus('linkedin', { pollMs: 5_000 });
  const linkedinConnect = useLinkedInStatus({ pollMs: 3_000 });
  const start = useStartLinkedInConnect();
  const disconnect = useDisconnectLinkedIn();

  const state = status.data?.state ?? 'not_configured';
  const label = (() => {
    switch (state) {
      case 'active':
        return <span className="text-success">● Active</span>;
      case 'paused':
        return <span className="text-ink-muted">⊘ Paused (credentials saved)</span>;
      case 'session_expired':
        return <span className="text-warning">⚠ Session expired</span>;
      default:
        return <span className="text-ink-muted">○ Not connected</span>;
    }
  })();

  const connected = state === 'active' || state === 'paused' || state === 'session_expired';

  return (
    <li className="flex items-center justify-between py-3">
      <div>
        <p className="font-medium text-ink-primary">LinkedIn</p>
        <p className="text-xs text-ink-secondary">{label}</p>
      </div>
      <div className="flex items-center gap-3">
        <SiteToggle id="linkedin" label="LinkedIn" />
        {connected ? (
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
            disabled={start.isPending || linkedinConnect.data?.attempting}
          >
            {linkedinConnect.data?.attempting ? 'Connecting…' : 'Connect'}
          </Button>
        )}
      </div>
    </li>
  );
}

function GoogleJobsRow(): JSX.Element {
  const status = useSiteStatus('google', { pollMs: 5_000 });
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

  const state = status.data?.state ?? 'not_configured';

  // Auto-close the inline edit form when the row falls back to not_configured
  // (typically after a successful Disconnect). The transition is driven by
  // server state surfacing through TanStack Query, not by anything inside
  // this component — an effect is the only way to react to it.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (state === 'not_configured') {
      setEditing(false);
      setKey('');
      setError(null);
    }
  }, [state]);
  /* eslint-enable react-hooks/set-state-in-effect */

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
        return <span className="text-ink-muted">⊘ Paused (credentials saved)</span>;
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
        <div className="flex items-center gap-3">
          <SiteToggle id="google" label="Google Jobs" />
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
        <LinkedInRow />
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
