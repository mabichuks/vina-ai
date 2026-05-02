import type { TaskKind } from '@vina/shared';

/**
 * Per-kind in-memory concurrency. The DB is still the source of truth for
 * persistence; these limits only govern how many same-kind tasks run in
 * parallel inside one daemon process.
 *
 * - `search`: 1 — keeps Playwright pressure per site predictable (we'll
 *   refine to per-site once browser-kind adapters land in M11)
 * - `score`: 4 — LLM-bound, batchable, network-friendly
 * - others: conservative until their handlers ship
 */
export const DEFAULT_CONCURRENCY: Record<TaskKind, number> = {
  search: 1,
  score: 4,
  tailor: 2,
  apply: 1,
  prepare_manual_apply: 2,
  resume: 1,
};
