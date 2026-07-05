import type { SessionExpiredHeuristics } from '../../detect/session.js';

/**
 * LinkedIn doesn't bounce logged-out browsers to /login — it serves real
 * public pages: /authwall, the guest homepage, and a guest "jserp" SERP
 * whose elements carry `public_jobs_*` tracking names (markup that never
 * appears on the authenticated experience). Expiry detection therefore
 * needs DOM markers, not just URL paths.
 */
export const LINKEDIN_SESSION_HEURISTICS: SessionExpiredHeuristics = {
  loginPathPatterns: [/^\/login/, /^\/uas\/login/, /^\/authwall/],
  selectors: ['[data-tracking-control-name^="public_jobs_"]'],
  textPatterns: ['Sign in to continue'],
};
