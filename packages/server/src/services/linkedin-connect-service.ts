import type { Database as DatabaseType } from 'better-sqlite3';
import type { BrowserManagerHandle, Page, SiteAdapter } from '@vina/automation';
import { createLogger } from '@vina/shared';
import type { EventBus } from '../events/bus.js';
import { updateSiteEnabled, updateSiteSession } from '../db/repositories/sites.js';

const log = createLogger('linkedin-connect-service');

const SITE_ID = 'linkedin';

export interface LinkedInConnectStatus {
  connected: boolean;
  attempting: boolean;
  last_success_at: string | null;
  error: string | null;
}

export interface LinkedInConnectServiceOptions {
  db: DatabaseType;
  bus: EventBus;
  browserManager: BrowserManagerHandle;
  adapter: SiteAdapter;
  /** Test seam: overrides the URL the page navigates to before polling. */
  loginUrlOverride?: string;
  /**
   * Test seam: when set, immediately after the initial navigation we navigate
   * the page to this URL, simulating the user successfully logging in. Real
   * usage leaves this undefined and the user drives login interactively.
   */
  onLoginSuccessNavigationOverride?: string;
  pollIntervalMs?: number;
  /** Default 5 minutes per spec §3.3. */
  timeoutMs?: number;
}

export interface LinkedInConnectService {
  startConnect(): Promise<void>;
  cancelConnect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): LinkedInConnectStatus;
}

export function createLinkedInConnectService(
  opts: LinkedInConnectServiceOptions,
): LinkedInConnectService {
  const pollMs = opts.pollIntervalMs ?? 1_500;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;

  let attempting = false;
  let lastSuccessAt: string | null = null;
  let lastError: string | null = null;
  let page: Page | null = null;
  let stopPoll: (() => void) | null = null;

  function getStatus(): LinkedInConnectStatus {
    return {
      connected: lastSuccessAt !== null,
      attempting,
      last_success_at: lastSuccessAt,
      error: lastError,
    };
  }

  async function persistConnected(): Promise<void> {
    lastSuccessAt = new Date().toISOString();
    updateSiteSession(opts.db, SITE_ID, {
      session_path: SITE_ID,
      session_valid_at: lastSuccessAt,
    });
    updateSiteEnabled(opts.db, SITE_ID, true);
  }

  async function startConnect(): Promise<void> {
    if (attempting) return;
    attempting = true;
    lastError = null;
    let ctx;
    try {
      ctx = await opts.browserManager.getContext(SITE_ID);
      page = await ctx.newPage();
      const loginUrl = opts.loginUrlOverride ?? opts.adapter.loginUrl;
      await page.goto(loginUrl);
      if (opts.onLoginSuccessNavigationOverride) {
        await page.goto(opts.onLoginSuccessNavigationOverride);
      }
    } catch (err) {
      attempting = false;
      lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }

    const startedAt = Date.now();
    let stopped = false;

    const tick = async (): Promise<boolean> => {
      if (stopped || !page) return true;
      if (page.isClosed()) {
        log.info('login page closed by user before success');
        attempting = false;
        page = null;
        return true;
      }
      try {
        if (await opts.adapter.onLoginSuccess(page)) {
          await persistConnected();
          attempting = false;
          await page.close().catch(() => undefined);
          page = null;
          return true;
        }
      } catch (err) {
        attempting = false;
        lastError = err instanceof Error ? err.message : String(err);
        await page?.close().catch(() => undefined);
        page = null;
        return true;
      }
      if (Date.now() - startedAt > timeoutMs) {
        attempting = false;
        lastError = 'timed_out';
        await page.close().catch(() => undefined);
        page = null;
        return true;
      }
      return false;
    };

    // Schedule the polling loop. We use setTimeout so we can chain ticks
    // and stop cleanly on cancel/success.
    let timer: NodeJS.Timeout | null = null;
    const schedule = (): void => {
      timer = setTimeout(async () => {
        const done = await tick();
        if (!done) schedule();
      }, pollMs);
    };
    stopPoll = (): void => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    };

    // Run a tick immediately too — useful for tests where the simulated
    // post-login navigation has already happened by the time startConnect
    // returns.
    const doneEarly = await tick();
    if (!doneEarly) schedule();
  }

  async function cancelConnect(): Promise<void> {
    stopPoll?.();
    stopPoll = null;
    attempting = false;
    if (page) {
      await page.close().catch(() => undefined);
      page = null;
    }
  }

  async function disconnect(): Promise<void> {
    await cancelConnect();
    await opts.browserManager.closeContext(SITE_ID);
    lastSuccessAt = null;
    lastError = null;
    updateSiteSession(opts.db, SITE_ID, { session_path: null, session_valid_at: null });
    updateSiteEnabled(opts.db, SITE_ID, false);
  }

  return { startConnect, cancelConnect, disconnect, getStatus };
}
