import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium, type BrowserContext } from 'playwright';
import { createLogger } from '@vina/shared';

const log = createLogger('automation.launch');

/** Files Chromium drops in a persistent profile to enforce single-instance use. */
const SINGLETON_NAMES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'] as const;

/**
 * Chromium creates `SingletonLock` (and cookie/socket siblings) on launch and
 * removes them on graceful exit. A `SIGKILL`-ed daemon, a force-quit Chrome,
 * or any crash leaves them behind — the next launch then fails with
 * `Failed to create a ProcessSingleton for your profile directory`. The lock
 * is a symlink whose target encodes `<hostname>-<pid>`; if that PID is no
 * longer running, the lock is stale and safe to remove. If the PID *is*
 * alive, we leave the files in place so the launch fails loudly (avoids
 * trampling a real concurrent Chromium on the same profile).
 */
async function clearStaleSingletonFiles(profileDir: string): Promise<void> {
  for (const name of SINGLETON_NAMES) {
    const file = path.join(profileDir, name);
    let target: string;
    try {
      target = await fs.readlink(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      log.warn({ err, file }, 'unexpected stat error on singleton file');
      continue;
    }
    // SingletonLock target looks like `users-MacBook-Pro.local-68936`. The
    // PID is the trailing integer; for SingletonCookie the target is just an
    // opaque hash (no PID encoded). Only the lock file is authoritative.
    if (name === 'SingletonLock') {
      const match = /-(\d+)$/.exec(target);
      const pid = match ? Number.parseInt(match[1]!, 10) : NaN;
      if (Number.isFinite(pid)) {
        try {
          process.kill(pid, 0); // throws ESRCH if dead
          log.warn(
            { profileDir, pid },
            'singleton lock owner is alive — refusing to clear',
          );
          return;
        } catch {
          // ESRCH — owner is gone, lock is stale, fall through to unlink.
        }
      }
    }
    try {
      await fs.unlink(file);
      log.info({ file, target }, 'removed stale singleton artefact');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn({ err, file }, 'failed to remove stale singleton artefact');
      }
    }
  }
}

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
  await clearStaleSingletonFiles(profileDir);

  log.debug(
    { siteId: opts.siteId, channel: opts.channel ?? 'bundled', headless: opts.headless ?? true },
    'launching persistent context',
  );

  return chromium.launchPersistentContext(profileDir, {
    headless: opts.headless ?? true,
    ...(opts.channel && { channel: opts.channel }),
  });
}
