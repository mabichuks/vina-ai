import type { BrowserContext } from 'playwright';
import { createLogger } from '@vina/shared';
import { launchCdpSession, type CdpSessionHandle, type LaunchCdpOptions } from './cdp.js';

const log = createLogger('automation.browser-manager');

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
  channel?: LaunchCdpOptions['channel'];
  /**
   * Opt-in stealth masking (ADR-021). Default `false`. Production wires this
   * from `settings.browser_stealth`.
   */
  stealth?: boolean;
}

export interface BrowserManagerHandle {
  /** Lazy-launch on first call per siteId; cached promise on repeat. */
  getContext(siteId: string): Promise<BrowserContext>;
  /**
   * Eager-launch the dedicated `external` session and return its loopback CDP
   * endpoint (`http://127.0.0.1:<port>`). Idempotent — returns the cached
   * endpoint on repeat. `headless` controls the launch (assisted runs headful,
   * autonomous follows `settings.browser_headful`).
   */
  ensureExternalSession(options?: { headless?: boolean }): Promise<string>;
  /**
   * The loopback CDP endpoint of the already-launched `external` session, or
   * `null` when none is running (e.g. `manual` mode). Synchronous so the host
   * can pass it to the Playwright MCP at `OpenCode.create` time.
   */
  cdpEndpoint(): string | null;
  /**
   * Close one site's session (e.g. on session-expired recovery). No-op
   * if no session is cached for that siteId. Disconnects CDP AND
   * terminates the Chromium process.
   */
  closeContext(siteId: string): Promise<void>;
  /**
   * Close every cached session. Errors during individual closes are caught
   * and logged so a single wedged session doesn't prevent the others from
   * closing during shutdown.
   */
  closeAll(): Promise<void>;
}

/**
 * Per-site managed-CDP session cache (ADR-022). Each site gets one Chromium
 * process attached over CDP, persisted across runs via the user-data-dir.
 * Concurrent `getContext` calls dedup to a single launch by caching the
 * in-flight launch promise.
 */
export function createBrowserManager(opts: BrowserManagerOptions): BrowserManagerHandle {
  const cache = new Map<string, Promise<CdpSessionHandle>>();
  /** Resolved loopback endpoint of the `external` session, cached for sync reads. */
  let externalEndpoint: string | null = null;

  const EXTERNAL_SITE_ID = 'external';

  function getSession(siteId: string, headless?: boolean): Promise<CdpSessionHandle> {
    const cached = cache.get(siteId);
    if (cached) return cached;

    const launching = launchCdpSession({
      siteId,
      dataDir: opts.dataDir,
      headless: headless ?? opts.headless ?? true,
      ...(opts.channel && { channel: opts.channel }),
      ...(opts.stealth !== undefined && { stealth: opts.stealth }),
    }).catch((err: unknown) => {
      // Evict on launch failure so the next caller retries instead of being
      // permanently stuck with a poisoned cache entry.
      cache.delete(siteId);
      if (siteId === EXTERNAL_SITE_ID) externalEndpoint = null;
      throw err;
    });
    cache.set(siteId, launching);
    return launching;
  }

  async function getContext(siteId: string): Promise<BrowserContext> {
    const session = await getSession(siteId);
    return session.context;
  }

  async function ensureExternalSession(options?: { headless?: boolean }): Promise<string> {
    if (externalEndpoint) return externalEndpoint;
    const session = await getSession(EXTERNAL_SITE_ID, options?.headless);
    externalEndpoint = `http://127.0.0.1:${session.port}`;
    return externalEndpoint;
  }

  function cdpEndpoint(): string | null {
    return externalEndpoint;
  }

  async function closeContext(siteId: string): Promise<void> {
    const cached = cache.get(siteId);
    if (!cached) return;
    cache.delete(siteId);
    if (siteId === EXTERNAL_SITE_ID) externalEndpoint = null;
    try {
      const session = await cached;
      await session.close();
    } catch (err) {
      log.warn({ err, siteId }, 'closeContext failed');
    }
  }

  async function closeAll(): Promise<void> {
    const entries = [...cache.entries()];
    cache.clear();
    externalEndpoint = null;
    await Promise.all(
      entries.map(async ([siteId, sessionPromise]) => {
        try {
          const session = await sessionPromise;
          await session.close();
        } catch (err) {
          log.warn({ err, siteId }, 'closeAll: session close failed');
        }
      }),
    );
  }

  return { getContext, ensureExternalSession, cdpEndpoint, closeContext, closeAll };
}
