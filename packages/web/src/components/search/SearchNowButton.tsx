import { useState } from 'react';
import { useRunSearchNow, useSiteStatus } from '../../api/resources.js';
import { useSearchProgressStore } from '../../store/search-progress-store.js';
import { useUiStore } from '../../store/ui-store.js';
import { Button } from '../ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.js';
import { useSearchGerund } from './use-search-gerund.js';

const SITE_LABELS: Record<string, string> = {
  linkedin: 'LinkedIn',
  google: 'Google Jobs',
};

/**
 * Search-now button that adapts to the number of active sources:
 * - 0 active → disabled with explanatory tooltip
 * - 1 active → single button that fans out to that site
 * - 2 active → dropdown with "Search both" / per-source options
 *
 * Label morphs through the discovering → scoring → done progression so the
 * user can see what's happening without watching the headless browser.
 */
export function SearchNowButton(): JSX.Element {
  const linkedin = useSiteStatus('linkedin', { pollMs: 5_000 });
  const google = useSiteStatus('google', { pollMs: 5_000 });
  const runNow = useRunSearchNow();
  const pushToast = useUiStore((s) => s.pushToast);
  const { phase, listingsFound, scoredCount, totalToScore, lastListingsTouched } =
    useSearchProgressStore();
  const gerund = useSearchGerund(phase);
  const [menuOpen, setMenuOpen] = useState(false);

  const activeSites: string[] = [
    linkedin.data?.state === 'active' ? 'linkedin' : null,
    google.data?.state === 'active' ? 'google' : null,
  ].filter((x): x is string => x !== null);

  const inFlight =
    runNow.isPending || phase === 'discovering' || phase === 'scoring';

  const label = (() => {
    if (runNow.isPending) return 'Starting search…';
    switch (phase) {
      case 'discovering':
        return listingsFound > 0
          ? `${gerund ?? 'Discovering'}… (${listingsFound} found)`
          : `${gerund ?? 'Discovering'}…`;
      case 'scoring':
        return totalToScore > 0
          ? `${gerund ?? 'Scoring'} ${scoredCount}/${totalToScore}…`
          : `${gerund ?? 'Scoring'}…`;
      case 'done':
        if (totalToScore > 0) return `Done · ${scoredCount} scored`;
        return lastListingsTouched > 0 ? 'Done · all up to date' : 'Done · no listings';
      case 'error':
        return 'Search failed — retry';
      default:
        return 'Search now';
    }
  })();

  const fireRunNow = async (sites: string[]): Promise<void> => {
    try {
      const results = await Promise.all(sites.map((id) => runNow.mutate(id)));
      if (results.length === 1 && results[0]!.deduped) {
        pushToast({ kind: 'info', message: 'Already searching…' });
      }
    } catch (err) {
      pushToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Search failed to start.',
      });
    }
  };

  if (activeSites.length === 0) {
    return (
      <Button disabled title="No source configured & active">
        {label}
      </Button>
    );
  }

  if (activeSites.length === 1) {
    const only = activeSites[0]!;
    return (
      <Button disabled={inFlight} onClick={() => void fireRunNow([only])}>
        {label}
      </Button>
    );
  }

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button disabled={inFlight}>
          {label}
          <span aria-hidden className="ml-2">
            ▾
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void fireRunNow(activeSites)}>
          Search both
        </DropdownMenuItem>
        {activeSites.map((id) => (
          <DropdownMenuItem key={id} onSelect={() => void fireRunNow([id])}>
            Search {SITE_LABELS[id] ?? id} only
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
