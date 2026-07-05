import * as childProcess from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { createLogger } from '@vina/shared';
import { stealthInitScripts, stealthLaunchArgs } from './stealth.js';

const log = createLogger('automation.cdp');

const SINGLETON_NAMES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'] as const;

/**
 * Chromium creates `SingletonLock` (and cookie/socket siblings) on launch and
 * removes them on graceful exit. A `SIGKILL`-ed daemon or crash leaves them
 * behind — the next launch then fails with `Failed to create a
 * ProcessSingleton for your profile directory`. If the encoded PID is no
 * longer running, the lock is stale and safe to remove. If alive, leave it.
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
    if (name === 'SingletonLock') {
      const match = /-(\d+)$/.exec(target);
      const pid = match ? Number.parseInt(match[1]!, 10) : NaN;
      if (Number.isFinite(pid)) {
        try {
          process.kill(pid, 0);
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

function pickFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close((closeErr) => {
        if (closeErr) return reject(closeErr);
        if (addr && typeof addr === 'object' && 'port' in addr) {
          resolve(addr.port);
        } else {
          reject(new Error('Could not allocate a loopback port'));
        }
      });
    });
  });
}

type Channel = 'chrome' | 'chrome-beta' | 'msedge';

function channelExecutablePath(channel: Channel): string | null {
  switch (process.platform) {
    case 'darwin':
      if (channel === 'chrome')
        return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      if (channel === 'chrome-beta')
        return '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta';
      if (channel === 'msedge')
        return '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
      return null;
    case 'linux':
      if (channel === 'chrome') return 'google-chrome';
      if (channel === 'chrome-beta') return 'google-chrome-beta';
      if (channel === 'msedge') return 'microsoft-edge';
      return null;
    default:
      // Windows path resolution requires registry lookup; fall through to
      // bundled Chromium. `vina doctor` already surfaces a hint when channel
      // chrome is unavailable.
      return null;
  }
}

async function waitForCdpReady(
  port: number,
  proc: childProcess.ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(
        `Chromium exited (code=${proc.exitCode}, signal=${proc.signalCode}) before CDP became ready`,
      );
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return;
      lastErr = new Error(`status ${r.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`CDP did not become ready on port ${port} within ${timeoutMs}ms: ${msg}`);
}

export interface LaunchCdpOptions {
  /** Site identifier (e.g. 'linkedin', 'indeed'). Determines the profile dir. */
  siteId: string;
  /** Vina data directory. The persistent profile lives at `<dataDir>/sessions/<siteId>/`. */
  dataDir: string;
  /** Headless flag. Defaults to true; production wires this from `settings.browser_headful`. */
  headless?: boolean;
  /**
   * Browser channel. Pass `'chrome'` in production (per ADR-018) for fewer
   * detection signals. Omit for Playwright's bundled Chromium (used by tests).
   * If the channel path can't be resolved on the current platform we fall back
   * to bundled.
   */
  channel?: Channel;
  /** Opt-in stealth flags from settings.browser_stealth (ADR-021). Default false. */
  stealth?: boolean;
  /** Test seam; default 30_000ms. */
  cdpReadyTimeoutMs?: number;
  /** Test seam; default child_process.spawn. */
  spawnFn?: typeof childProcess.spawn;
}

export interface CdpSessionHandle {
  /** The persistent BrowserContext to drive — first context from the attached browser. */
  context: BrowserContext;
  /** The connected Browser. Closing it disconnects CDP but does NOT terminate Chromium. */
  browser: Browser;
  /** The loopback debug port. */
  port: number;
  /** PID of the spawned Chromium process. */
  pid: number | undefined;
  /** Disconnect CDP and terminate the Chromium process (SIGTERM → SIGKILL after 5s). */
  close(): Promise<void>;
}

/**
 * Launch a local Chromium with a loopback `--remote-debugging-port` and
 * attach Playwright over CDP (ADR-022). The browser process is owned by this
 * function — the returned handle's `close()` MUST be awaited to terminate it.
 *
 * Security: the debug port is an unauthenticated control channel. We bind it
 * to `127.0.0.1` only — never `0.0.0.0`.
 */
export async function launchCdpSession(
  opts: LaunchCdpOptions,
): Promise<CdpSessionHandle> {
  const profileDir = path.join(opts.dataDir, 'sessions', opts.siteId);
  await fs.mkdir(profileDir, { recursive: true });
  await clearStaleSingletonFiles(profileDir);

  const port = await pickFreeLoopbackPort();
  const channelPath = opts.channel ? channelExecutablePath(opts.channel) : null;
  const executable = channelPath ?? chromium.executablePath();
  const headless = opts.headless ?? true;
  const stealth = opts.stealth ?? false;

  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    `--remote-debugging-address=127.0.0.1`,
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--use-mock-keychain',
    // Playwright's own launcher adds this by default on Linux; our raw
    // spawn must too — CI containers/VMs mount a small /dev/shm and
    // Chromium aborts (SIGABRT) before CDP comes up without it.
    '--disable-dev-shm-usage',
    ...(headless ? ['--headless=new', '--disable-gpu'] : []),
    // Chromium's sandbox needs unprivileged user namespaces, which some CI
    // kernels (Ubuntu 24.04 AppArmor default) restrict — the process aborts
    // at startup. Explicit opt-in only: user machines keep the sandbox for
    // real browsing sessions.
    ...(process.env['VINA_CHROMIUM_NO_SANDBOX'] === '1' ? ['--no-sandbox'] : []),
    ...stealthLaunchArgs(stealth),
  ];

  log.debug(
    {
      siteId: opts.siteId,
      port,
      headless,
      channel: opts.channel ?? 'bundled',
      stealth,
    },
    'launching managed CDP browser',
  );

  const spawnFn = opts.spawnFn ?? childProcess.spawn;
  const proc = spawnFn(executable, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  proc.on('error', (err) => log.warn({ err, siteId: opts.siteId }, 'chromium process error'));

  try {
    await waitForCdpReady(port, proc, opts.cdpReadyTimeoutMs ?? 30_000);
  } catch (err) {
    try {
      proc.kill('SIGKILL');
    } catch {
      // ignored — best-effort cleanup on failed launch
    }
    throw err;
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const existing = browser.contexts();
  const context = existing[0] ?? (await browser.newContext());

  const scripts = await stealthInitScripts(stealth);
  for (const script of scripts) {
    await context.addInitScript(script);
  }

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    try {
      await browser.close();
    } catch (err) {
      log.warn({ err, siteId: opts.siteId }, 'browser disconnect failed');
    }
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignored — process already gone
        }
        resolve(false);
      }, 5_000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
      try {
        proc.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        resolve(true);
      }
    });
    if (!exited) {
      log.warn(
        { pid: proc.pid, siteId: opts.siteId },
        'chromium did not exit on SIGTERM; sent SIGKILL',
      );
    }
  }

  return { context, browser, port, pid: proc.pid, close };
}
