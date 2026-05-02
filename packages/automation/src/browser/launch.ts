import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium, type BrowserContext } from 'playwright';
import { createLogger } from '@vina/shared';

const log = createLogger('automation.launch');

export interface LaunchSiteContextOptions {
  /** Site identifier (e.g. 'linkedin', 'indeed'). Determines the profile dir. */
  siteId: string;
  /** Vina data directory. The persistent profile lives at `<dataDir>/sessions/<siteId>/`. */
  dataDir: string;
  /** Headless flag. Defaults to true; production wires this from `settings.browser_headful`. */
  headless?: boolean;
  /**
   * Browser channel. Pass `'chrome'` in production (per ADR-018) for fewer
   * detection signals. Pass `undefined` for Playwright's bundled Chromium —
   * tests use this, and so does production when `vina doctor` reports
   * Google Chrome is missing.
   */
  channel?: 'chrome' | 'chrome-beta' | 'msedge';
}

/**
 * Launch a persistent BrowserContext for a site. Wraps Playwright's
 * `launchPersistentContext` with the conventions from ADR-018:
 *
 * - One persistent profile dir per site at `<dataDir>/sessions/<siteId>/`
 *   (cookies, localStorage, IndexedDB, cache all live there)
 * - System locale and timezone — no anti-detection beyond the legitimate
 *   session approach (ADR-013)
 * - Default viewport — never randomise
 *
 * The caller owns the returned context's lifecycle and must `await
 * context.close()` on shutdown. The bundled `BrowserManager` (M11 Task 2)
 * is the canonical caller; direct callers should be rare and well-justified.
 */
export async function launchSiteContext(
  opts: LaunchSiteContextOptions,
): Promise<BrowserContext> {
  const profileDir = path.join(opts.dataDir, 'sessions', opts.siteId);
  await fs.mkdir(profileDir, { recursive: true });

  log.debug(
    { siteId: opts.siteId, channel: opts.channel ?? 'bundled', headless: opts.headless ?? true },
    'launching persistent context',
  );

  return chromium.launchPersistentContext(profileDir, {
    headless: opts.headless ?? true,
    ...(opts.channel && { channel: opts.channel }),
  });
}
