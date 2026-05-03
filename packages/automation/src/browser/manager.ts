import type { BrowserContext } from 'playwright';
import { createLogger } from '@vina/shared';
import { launchSiteContext, type LaunchSiteContextOptions } from './launch.js';

const log = createLogger('browser-manager');

export interface BrowserManagerOptions {
  /** Vina data directory. Persistent profiles live at `<dataDir>/sessions/<siteId>/`. */
  dataDir: string;
  /** Defaults to `true`. Production reads `settings.browser_headful` and inverts. */
  headless?: boolean;
  /**
   * Browser channel — pass `'chrome'` in production for fewer detection
   * signals (per ADR-018). Omit to use Playwright's bundled Chromium
   * (tests, environments without Chrome installed).
   */
  channel?: LaunchSiteContextOptions['channel'];
}

export interface BrowserManagerHandle {
  /** Lazy-launch on first call per siteId; cached promise on repeat. */
  getContext(siteId: string): Promise<BrowserContext>;
  /**
   * Close one site's context (e.g. on session-expired recovery). No-op
   * if no context is cached for that siteId.
   */
  closeContext(siteId: string): Promise<void>;
  /**
   * Close every cached context. Errors during individual closes are
   * caught and logged so a single wedged context doesn't prevent the
   * others from closing during shutdown.
   */
  closeAll(): Promise<void>;
}

/**
 * Per-site persistent BrowserContext cache. Sits on top of
 * `launchSiteContext` from this same `browser/` directory and adds
 * lifecycle (cache, close-one, close-all) plus concurrent-launch
 * deduplication (storing the promise rather than the resolved context
 * means two simultaneous getContext calls await the same launch instead
 * of racing two `launchPersistentContext` calls into the same profile
 * dir, which Playwright would reject).
 */
export function createBrowserManager(opts: BrowserManagerOptions): BrowserManagerHandle {
  const cache = new Map<string, Promise<BrowserContext>>();

  function getContext(siteId: string): Promise<BrowserContext> {
    const cached = cache.get(siteId);
    if (cached) return cached;

    const launching = launchSiteContext({
      siteId,
      dataDir: opts.dataDir,
      headless: opts.headless ?? true,
      ...(opts.channel && { channel: opts.channel }),
    });
    cache.set(siteId, launching);
    return launching;
  }

  async function closeContext(siteId: string): Promise<void> {
    const cached = cache.get(siteId);
    if (!cached) return;
    cache.delete(siteId);
    try {
      const ctx = await cached;
      await ctx.close();
    } catch (err) {
      log.warn({ err, siteId }, 'closeContext failed');
    }
  }

  async function closeAll(): Promise<void> {
    const entries = [...cache.entries()];
    cache.clear();
    await Promise.all(
      entries.map(async ([siteId, ctxPromise]) => {
        try {
          const ctx = await ctxPromise;
          await ctx.close();
        } catch (err) {
          log.warn({ err, siteId }, 'closeAll: context close failed');
        }
      }),
    );
  }

  return { getContext, closeContext, closeAll };
}
