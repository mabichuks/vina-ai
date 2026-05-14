import { useEffect, useState } from 'react';
import type { SearchPhase } from '../../store/search-progress-store.js';

const POOLS: Partial<Record<SearchPhase, readonly string[]>> = {
  discovering: [
    'Sussing',
    'Snooping',
    'Sleuthing',
    'Rummaging',
    'Combing',
    'Scouting',
    'Prowling',
    'Trawling',
  ],
  scoring: [
    'Pondering',
    'Mulling',
    'Weighing',
    'Judging',
    'Sizing-up',
    'Vibing',
    'Noodling',
    'Appraising',
  ],
};

/**
 * Returns a rotating gerund for the active search phase, swapping every
 * `intervalMs`. Returns `null` for phases without a pool (idle/done/error) so
 * callers can fall back to their existing static labels.
 */
export function useSearchGerund(phase: SearchPhase, intervalMs = 1500): string | null {
  const pool = POOLS[phase] ?? null;
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * 1000));

  useEffect(() => {
    if (!pool) return undefined;
    const id = setInterval(() => setIdx((i) => i + 1), intervalMs);
    return () => clearInterval(id);
  }, [pool, intervalMs]);

  if (!pool) return null;
  return pool[idx % pool.length] ?? null;
}
