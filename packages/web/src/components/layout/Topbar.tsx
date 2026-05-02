import { useSystemStatus, useTogglePause } from '../../api/system.js';
import { useUiStore } from '../../store/ui-store.js';
import { FinishSetupPill } from './FinishSetupPill.js';

function StatusDot({ tone }: { tone: 'green' | 'amber' | 'red' }): JSX.Element {
  const cls = {
    green: 'bg-success',
    amber: 'bg-warning',
    red: 'bg-danger',
  }[tone];
  return <span aria-hidden className={`inline-block h-2 w-2 rounded-pill ${cls}`} />;
}

export function Topbar(): JSX.Element {
  const { data: status } = useSystemStatus();
  const { pause, resume, isPending } = useTogglePause();
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);

  // Tone reflects: red if no daemon reachable, amber if paused or no provider
  // configured, green otherwise. Phase 7 has limited signal, so the rule will
  // tighten as Phase 6 / 9 add more readiness checks.
  const tone: 'green' | 'amber' | 'red' = !status
    ? 'red'
    : !status.scheduler.running || !status.active_provider
      ? 'amber'
      : 'green';

  const paused = status ? !status.scheduler.running : false;

  return (
    <header className="flex h-12 items-center justify-between border-b border-border-subtle bg-surface-base px-4">
      <div className="flex items-center gap-2 text-sm text-ink-secondary">
        <StatusDot tone={tone} />
        <span>{status ? `v${status.version}` : 'connecting…'}</span>
      </div>

      <div className="flex items-center gap-2">
        <FinishSetupPill />

        <button
          type="button"
          onClick={paused ? resume : pause}
          disabled={isPending || !status}
          className="rounded-md border border-border-subtle bg-surface-raised px-3 py-1 text-xs font-medium text-ink-primary transition hover:bg-surface-sunken disabled:opacity-50"
        >
          {paused ? 'Resume' : 'Pause'}
        </button>

        <button
          type="button"
          onClick={toggleTheme}
          className="rounded-md border border-border-subtle bg-surface-raised px-2 py-1 text-xs text-ink-secondary transition hover:bg-surface-sunken"
          aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
          title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
        >
          {theme === 'light' ? '🌙' : '☀️'}
        </button>

        <button
          type="button"
          className="rounded-md border border-border-subtle bg-surface-raised px-3 py-1 text-xs text-ink-primary transition hover:bg-surface-sunken"
        >
          Chat
        </button>
      </div>
    </header>
  );
}
