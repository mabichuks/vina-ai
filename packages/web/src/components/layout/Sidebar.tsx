import { NavLink } from 'react-router-dom';
import { useAlerts } from '../../api/resources.js';

interface NavItem {
  to: string;
  label: string;
  /** Pulled from alerts count if set. */
  badgeAlertKind?: string;
}

const ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard' },
  { to: '/jobs', label: 'Jobs' },
  { to: '/ready', label: 'Ready to apply', badgeAlertKind: 'ready_for_manual_apply' },
  { to: '/applications', label: 'Applications' },
  { to: '/alerts', label: 'Alerts' },
  { to: '/profile', label: 'Profile' },
  { to: '/settings', label: 'Settings' },
];

export function Sidebar(): JSX.Element {
  const alerts = useAlerts();
  const counts = new Map<string, number>();
  for (const a of alerts.data) {
    if (a.status === 'open') {
      counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
    }
  }

  return (
    <nav
      aria-label="Primary"
      className="flex h-full w-56 shrink-0 flex-col gap-1 border-r border-border-subtle bg-surface-raised p-3"
    >
      <div className="px-2 pb-3 pt-1 font-display text-xl font-headline tracking-tight text-ink-primary">
        Vina
      </div>
      <ul className="flex flex-col gap-0.5">
        {ITEMS.map((item) => {
          const count = item.badgeAlertKind ? (counts.get(item.badgeAlertKind) ?? 0) : 0;
          return (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  [
                    'flex items-center justify-between rounded-md px-3 py-1.5 text-sm transition',
                    isActive
                      ? 'bg-accent-soft text-ink-primary'
                      : 'text-ink-secondary hover:bg-surface-sunken hover:text-ink-primary',
                  ].join(' ')
                }
              >
                <span>{item.label}</span>
                {count > 0 && (
                  <span className="ml-2 rounded-full bg-warning px-1.5 py-0.5 text-2xs font-mono text-on-warning">
                    {count}
                  </span>
                )}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
