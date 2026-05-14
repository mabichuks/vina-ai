import { create } from 'zustand';

/**
 * UX state for the search lifecycle. Lives in the browser; reset on tab
 * reload. The WebSocket dispatcher in `api/ws.ts` updates this store as
 * `search:*` and `jobs:updated` events arrive — components subscribe via
 * `useSearchProgressStore` to render phase-aware UI (search-now button
 * label, Dashboard activity panel, etc).
 *
 * Phase transitions:
 *   idle          → user clicks Search now
 *   discovering   → `search:started` received
 *                   `jobs:updated` events during this phase count as listings
 *   scoring       → `search:completed { scored }` received
 *                   `jobs:updated` events now count as score completions
 *   done          → scoredCount ≥ totalToScore (auto-resets to idle after 4s)
 *   error         → `search:failed` (auto-resets to idle after 8s)
 *
 * The store is intentionally loose: `jobs:updated` events also fire when the
 * user marks something applied/skipped, so counts can drift by one or two
 * during a search. That's fine — counts are for "give the user a sense of
 * progress," not strict accounting.
 */

export type SearchPhase = 'idle' | 'discovering' | 'scoring' | 'done' | 'error';

interface SearchProgressState {
  phase: SearchPhase;
  listingsFound: number;
  scoredCount: number;
  totalToScore: number;
  errorKind: string | null;
  /** Timestamp of the latest phase transition; used for "x seconds ago." */
  phaseChangedAt: number;
}

interface SearchProgressActions {
  beginDiscovering: () => void;
  countDiscoveredListings: (n: number) => void;
  beginScoring: (totalToScore: number) => void;
  countScored: (n: number) => void;
  markDone: () => void;
  markError: (errorKind: string) => void;
  reset: () => void;
}

const INITIAL: SearchProgressState = {
  phase: 'idle',
  listingsFound: 0,
  scoredCount: 0,
  totalToScore: 0,
  errorKind: null,
  phaseChangedAt: 0,
};

export const useSearchProgressStore = create<SearchProgressState & SearchProgressActions>(
  (set) => ({
    ...INITIAL,
    beginDiscovering: () =>
      set({
        phase: 'discovering',
        listingsFound: 0,
        scoredCount: 0,
        totalToScore: 0,
        errorKind: null,
        phaseChangedAt: Date.now(),
      }),
    countDiscoveredListings: (n) =>
      set((s) =>
        s.phase === 'discovering'
          ? { listingsFound: s.listingsFound + n }
          : s,
      ),
    beginScoring: (totalToScore) =>
      set({
        // When the search produced no new score tasks we skip 'scoring' entirely
        // — staying there would leave the UI stuck on "Scoring 0/0".
        phase: totalToScore > 0 ? 'scoring' : 'done',
        totalToScore,
        scoredCount: 0,
        phaseChangedAt: Date.now(),
      }),
    countScored: (n) =>
      set((s) => {
        if (s.phase !== 'scoring') return s;
        const scoredCount = Math.min(s.scoredCount + n, Math.max(s.totalToScore, 0));
        return scoredCount >= s.totalToScore && s.totalToScore > 0
          ? { scoredCount, phase: 'done', phaseChangedAt: Date.now() }
          : { scoredCount };
      }),
    markDone: () =>
      set((s) => (s.phase === 'done' ? s : { phase: 'done', phaseChangedAt: Date.now() })),
    markError: (errorKind) =>
      set((s) =>
        s.phase === 'error' && s.errorKind === errorKind
          ? s
          : { phase: 'error', errorKind, phaseChangedAt: Date.now() },
      ),
    reset: () => set({ ...INITIAL, phaseChangedAt: Date.now() }),
  }),
);

/** Auto-reset after a terminal phase so the button returns to "Search now." */
useSearchProgressStore.subscribe((state) => {
  if (state.phase === 'done' || state.phase === 'error') {
    const resetAfterMs = state.phase === 'done' ? 4_000 : 8_000;
    const stamp = state.phaseChangedAt;
    setTimeout(() => {
      const current = useSearchProgressStore.getState();
      // Only reset if we're still in the same terminal phase — a new search
      // could have started in the interim.
      if (current.phaseChangedAt === stamp) current.reset();
    }, resetAfterMs);
  }
});
