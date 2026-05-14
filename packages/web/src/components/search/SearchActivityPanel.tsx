import { useEffect, useState } from 'react';
import { useSearchProgressStore } from '../../store/search-progress-store.js';
import { useSearchGerund } from './use-search-gerund.js';

/**
 * Compact panel that mirrors `useSearchProgressStore` for users who need
 * more context than the button's label affords — e.g. on the Dashboard
 * where the user might be elsewhere on the page when a search runs. Hides
 * itself in the idle phase so it doesn't clutter when nothing is happening.
 */
export function SearchActivityPanel(): JSX.Element | null {
  const { phase, listingsFound, scoredCount, totalToScore, errorKind, phaseChangedAt } =
    useSearchProgressStore();
  const gerund = useSearchGerund(phase);

  // Tick once a second while a search is active so "started Ns ago" stays fresh.
  // `nowMs` lives in state so the elapsed read is pure under React's purity rule;
  // the only setState happens inside an async interval callback, not the effect body.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (phase === 'idle') return undefined;
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [phase]);

  if (phase === 'idle') return null;

  const elapsedSeconds = Math.max(0, Math.round((nowMs - phaseChangedAt) / 1000));
  const elapsed =
    elapsedSeconds < 60 ? `${elapsedSeconds}s` : `${Math.floor(elapsedSeconds / 60)}m`;

  const headline = (() => {
    switch (phase) {
      case 'discovering':
        return listingsFound > 0
          ? `${gerund ?? 'Discovering'} · ${listingsFound} found`
          : `${gerund ?? 'Discovering'}…`;
      case 'scoring':
        return totalToScore > 0
          ? `${gerund ?? 'Scoring'} · ${scoredCount}/${totalToScore}`
          : `${gerund ?? 'Scoring'}…`;
      case 'done':
        return totalToScore > 0
          ? `Done · ${scoredCount} new jobs scored`
          : 'Done · no new jobs this run';
      case 'error':
        return errorKind === 'session_expired'
          ? 'Search failed · LinkedIn session expired'
          : 'Search failed';
      default:
        return '';
    }
  })();

  const tone = (() => {
    switch (phase) {
      case 'error':
        return 'border-danger bg-danger-soft text-danger';
      case 'done':
        return 'border-success bg-success-soft text-success';
      default:
        return 'border-border-subtle bg-surface-raised text-ink-primary';
    }
  })();

  const progress =
    phase === 'scoring' && totalToScore > 0
      ? Math.min(100, Math.round((scoredCount / totalToScore) * 100))
      : phase === 'done'
        ? 100
        : null;

  return (
    <div className={`rounded-md border px-4 py-3 ${tone}`}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{headline}</span>
        <span className="text-xs text-ink-muted">{elapsed} elapsed</span>
      </div>
      {progress !== null && (
        <div
          className="mt-2 h-1 w-full overflow-hidden rounded-full bg-surface-sunken"
          aria-hidden
        >
          <div
            className="h-full bg-accent transition-[width] duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </div>
  );
}
