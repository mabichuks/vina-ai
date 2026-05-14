import type { Database as DatabaseType } from 'better-sqlite3';
import type { BrowserContext, BrowserManagerHandle, Page, SiteAdapter } from '@vina/automation';
import { launchSiteContext } from '@vina/automation';
import { createLogger } from '@vina/shared';
import type { EventBus } from '../events/bus.js';
import { findSiteById, updateSiteEnabled, updateSiteSession } from '../db/repositories/sites.js';

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
  /** Vina data directory — used to launch a headed Chromium directly on the
   * persistent profile when the connect attempt starts. */
  dataDir: string;
  /** Test seam: overrides the URL the page navigates to before polling. */
  loginUrlOverride?: string;
  /**
   * Test seam: when set, immediately after the initial navigation we navigate
   * the page to this URL, simulating the user successfully logging in. Real
   * usage leaves this undefined and the user drives login interactively.
   */
  onLoginSuccessNavigationOverride?: string;
  /**
   * Test seam: bypass the headed-launch path and use the shared
   * BrowserManager (which is headless in tests). Production never sets this.
   */
  useManagerForLaunch?: boolean;
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

  // Hydrate from DB so the service knows about a session persisted by a prior
  // process. Without this, daemon restart would surface `connected: false`
  // even though `sites.linkedin.session_valid_at` is set, which then disables
  // the Search-now button until the user re-authenticates.
  let lastSuccessAt: string | null =
    findSiteById(opts.db, SITE_ID)?.session_valid_at ?? null;

  let attempting = false;
  let lastError: string | null = null;
  let page: Page | null = null;
  /** Owned context when we launched headed ourselves; null when reusing the manager. */
  let ownedCtx: BrowserContext | null = null;
  let stopPoll: (() => void) | null = null;

  // Subscribe to session-expired events from the search worker. The DB's
  // `session_valid_at` is only proof that we *once* logged in successfully —
  // it doesn't guarantee the persisted cookies still authenticate (LinkedIn
  // routinely invalidates them, and headless contexts often get a different
  // auth verdict than the headed connect did). When the worker reports the
  // session is dead, clear the in-memory connected state and persist that
  // back to the DB so the UI flips to "not connected" / "Reconnect".
  opts.bus.on('linkedin:session-expired', () => {
    lastSuccessAt = null;
    lastError = 'session_expired';
    updateSiteSession(opts.db, SITE_ID, {
      session_path: null,
      session_valid_at: null,
    });
  });

  function getStatus(): LinkedInConnectStatus {
    return {
      connected: lastSuccessAt !== null,
      attempting,
      last_success_at: lastSuccessAt,
      error: lastError,
    };
  }

  async function teardownPage(): Promise<void> {
    if (page) {
      await page.close().catch(() => undefined);
      page = null;
    }
    if (ownedCtx) {
      await ownedCtx.close().catch(() => undefined);
      ownedCtx = null;
    }
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
    try {
      if (opts.useManagerForLaunch) {
        // Test path — reuse the shared (headless) manager context.
        const ctx = await opts.browserManager.getContext(SITE_ID);
        page = await ctx.newPage();
      } else {
        // Production path — close any cached headless context on the same
        // profile dir, then launch headed Chromium directly so the user can
        // see and interact with the login form. Playwright disallows two
        // contexts on one profile dir, hence the explicit close first.
        await opts.browserManager.closeContext(SITE_ID);
        ownedCtx = await launchSiteContext({
          siteId: SITE_ID,
          dataDir: opts.dataDir,
          headless: false,
        });
        page = await ownedCtx.newPage();
      }
      const loginUrl = opts.loginUrlOverride ?? opts.adapter.loginUrl;
      await page.goto(loginUrl);
      if (opts.onLoginSuccessNavigationOverride) {
        await page.goto(opts.onLoginSuccessNavigationOverride);
      }
    } catch (err) {
      attempting = false;
      lastError = err instanceof Error ? err.message : String(err);
      await teardownPage();
      throw err;
    }

    const startedAt = Date.now();
    let stopped = false;

    const tick = async (): Promise<boolean> => {
      if (stopped || !page) return true;
      if (page.isClosed()) {
        log.info('login page closed by user before success');
        attempting = false;
        await teardownPage();
        return true;
      }
      try {
        if (await opts.adapter.onLoginSuccess(page)) {
          await persistConnected();
          attempting = false;
          await teardownPage();
          return true;
        }
      } catch (err) {
        attempting = false;
        lastError = err instanceof Error ? err.message : String(err);
        await teardownPage();
        return true;
      }
      if (Date.now() - startedAt > timeoutMs) {
        attempting = false;
        lastError = 'timed_out';
        await teardownPage();
        return true;
      }
      return false;
    };

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

    const doneEarly = await tick();
    if (!doneEarly) schedule();
  }

  async function cancelConnect(): Promise<void> {
    stopPoll?.();
    stopPoll = null;
    attempting = false;
    await teardownPage();
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
