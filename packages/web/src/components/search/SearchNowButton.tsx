import {
  useLinkedInStatus,
  useRunSearchNow,
} from '../../api/resources.js';
import { useSearchProgressStore } from '../../store/search-progress-store.js';
import { useUiStore } from '../../store/ui-store.js';
import { Button } from '../ui/button.js';
import { useSearchGerund } from './use-search-gerund.js';

/**
 * Search-now button that surfaces lifecycle state from
 * `useSearchProgressStore` instead of a generic spinner. Label morphs through
 * the search → score progression so the user can see what's happening
 * without watching the headless browser.
 */
export function SearchNowButton(): JSX.Element {
  const linkedin = useLinkedInStatus({ pollMs: 5_000 });
  const runNow = useRunSearchNow();
  const pushToast = useUiStore((s) => s.pushToast);
  const { phase, listingsFound, scoredCount, totalToScore } = useSearchProgressStore();
  const gerund = useSearchGerund(phase);

  const sessionExpired =
    linkedin.data !== null && !linkedin.data.connected && linkedin.data.error !== null;
  // `runNow.isPending` covers the moment between click and the WS
  // `search:started` event; without it the button would flash back to idle
  // before the store transitions into 'discovering'.
  const inFlight =
    runNow.isPending || phase === 'discovering' || phase === 'scoring';
  const disabled = !linkedin.data?.connected || sessionExpired || inFlight;

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
        return totalToScore > 0
          ? `Done · ${scoredCount} scored`
          : 'Done · no new jobs';
      case 'error':
        return 'Search failed — retry';
      default:
        return 'Search now';
    }
  })();

  return (
    <Button
      disabled={disabled}
      onClick={async () => {
        try {
          const r = await runNow.mutate('linkedin');
          if (r.deduped) {
            pushToast({ kind: 'info', message: 'Already searching…' });
          }
        } catch (err) {
          pushToast({
            kind: 'error',
            message: err instanceof Error ? err.message : 'Search failed to start.',
          });
        }
      }}
    >
      {label}
    </Button>
  );
}
