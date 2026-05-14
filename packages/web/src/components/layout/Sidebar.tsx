import { NavLink } from 'react-router-dom';

interface NavItem {
  to: string;
  label: string;
}

const ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard' },
  { to: '/jobs', label: 'Jobs' },
  { to: '/applications', label: 'Applications' },
  { to: '/alerts', label: 'Alerts' },
  { to: '/profile', label: 'Profile' },
  { to: '/settings', label: 'Settings' },
];

export function Sidebar(): JSX.Element {
  return (
    <nav
      aria-label="Primary"
      className="flex h-full w-56 shrink-0 flex-col gap-1 border-r border-border-subtle bg-surface-raised p-3"
    >
      <div className="px-2 pb-3 pt-1 font-display text-xl font-headline tracking-tight text-ink-primary">
        Vina
      </div>
      <ul className="flex flex-col gap-0.5">
        {ITEMS.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                [
                  'block rounded-md px-3 py-1.5 text-sm transition',
                  isActive
                    ? 'bg-accent-soft text-accent'
                    : 'text-ink-secondary hover:bg-surface-sunken hover:text-ink-primary',
                ].join(' ')
              }
            >
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
