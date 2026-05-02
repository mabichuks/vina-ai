import type { TaskKind } from '@vina/shared';

/**
 * Per-kind handler timeouts in milliseconds. A handler that exceeds its
 * timeout rejects with a `handler_timeout` error and goes through the
 * normal retry path — assume the underlying cause is transient (slow LLM,
 * wedged Playwright nav, network blip).
 *
 * Sized to be lenient enough that legitimately-slow runs don't get cut
 * (LLM tail latencies, multi-step Playwright forms) while still bounding
 * the worst case so a single wedged handler can't permanently hold its
 * PQueue lane.
 */
export const DEFAULT_TIMEOUTS_MS: Record<TaskKind, number> = {
  search: 5 * 60 * 1000, // Playwright nav + listing iteration + apply-method detection
  score: 60 * 1000, // single structured-output LLM call
  tailor: 2 * 60 * 1000, // LLM call + DOCX render
  apply: 10 * 60 * 1000, // multi-step form filling, possible CAPTCHA pause
  prepare_manual_apply: 2 * 60 * 1000, // tailor-cv + cover-letter, no browser
  resume: 60 * 1000, // re-enqueue + reload state
};
