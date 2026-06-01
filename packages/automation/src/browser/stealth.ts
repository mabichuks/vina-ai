/**
 * Opt-in anti-detection masking (ADR-021). Off by default; only when the user
 * sets `browser_stealth=true` in Settings does any masking apply. When off,
 * every export here is a no-op and the launch path is unchanged.
 *
 * Kept intentionally thin in Change 2: only Chromium launch flags ship. The
 * `stealthInitScripts` seam is in place for a future stealth dependency
 * (e.g. `playwright-extra` + stealth plugin), loaded lazily so the default
 * install carries no extra runtime weight.
 */

const MASKING_LAUNCH_ARGS: readonly string[] = [
  // Suppresses navigator.webdriver and the AutomationControlled Blink feature.
  '--disable-blink-features=AutomationControlled',
];

export function stealthLaunchArgs(stealth: boolean): string[] {
  if (!stealth) return [];
  return [...MASKING_LAUNCH_ARGS];
}

/**
 * Returns init scripts to inject into every page when stealth is enabled.
 * Currently returns `[]`; the seam is wired so a future stealth dependency
 * can be lazy-imported here without rippling through callers.
 */
export async function stealthInitScripts(stealth: boolean): Promise<string[]> {
  if (!stealth) return [];
  return [];
}
