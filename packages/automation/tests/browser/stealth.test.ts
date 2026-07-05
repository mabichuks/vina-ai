import { describe, expect, it } from 'vitest';
import { stealthLaunchArgs, stealthInitScripts } from '../../src/browser/stealth.js';

describe('stealth (ADR-021 opt-in masking)', () => {
  it('stealthLaunchArgs returns [] when stealth is off (default posture)', () => {
    expect(stealthLaunchArgs(false)).toEqual([]);
  });

  it('stealthLaunchArgs returns masking args when stealth is on', () => {
    const args = stealthLaunchArgs(true);
    expect(args.length).toBeGreaterThan(0);
    // The single most load-bearing flag: suppresses navigator.webdriver and the
    // Blink AutomationControlled feature. Anything else is supplementary.
    expect(args).toContain('--disable-blink-features=AutomationControlled');
  });

  it('stealthInitScripts resolves to [] when stealth is off', async () => {
    await expect(stealthInitScripts(false)).resolves.toEqual([]);
  });

  it('stealthInitScripts resolves to an array (possibly empty) when stealth is on', async () => {
    const scripts = await stealthInitScripts(true);
    expect(Array.isArray(scripts)).toBe(true);
  });
});
