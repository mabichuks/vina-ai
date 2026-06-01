import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launchCdpSession } from '../../src/browser/cdp.js';

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vina-cdp-test-'));
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('launchCdpSession', () => {
  it('launches a managed Chromium with a loopback debug port and returns a usable context', async () => {
    const handle = await launchCdpSession({ siteId: 'unit', dataDir });
    try {
      const page = await handle.context.newPage();
      await page.goto('about:blank');
      expect(await page.title()).toBe('');
      expect(handle.port).toBeGreaterThan(0);

      // The debug endpoint is reachable on loopback.
      const r = await fetch(`http://127.0.0.1:${handle.port}/json/version`);
      expect(r.ok).toBe(true);
    } finally {
      await handle.close();
    }
  }, 30_000);

  it('creates the profile dir at <dataDir>/sessions/<siteId>/ and writes profile files', async () => {
    const handle = await launchCdpSession({ siteId: 'profile-shape', dataDir });
    await handle.close();

    const profileDir = path.join(dataDir, 'sessions', 'profile-shape');
    const stat = await fs.stat(profileDir);
    expect(stat.isDirectory()).toBe(true);
    const entries = await fs.readdir(profileDir);
    expect(entries.length).toBeGreaterThan(0);
  }, 30_000);

  it('binds the debug port to loopback (passes --remote-debugging-address=127.0.0.1)', async () => {
    let recordedArgs: readonly string[] | null = null;
    const recordingSpawn = (
      cmd: string,
      args?: readonly string[],
      options?: SpawnOptions,
    ): ChildProcess => {
      recordedArgs = args ?? [];
      return spawn(cmd, args ?? [], options ?? {});
    };

    const handle = await launchCdpSession({
      siteId: 'loopback-args',
      dataDir,
      spawnFn: recordingSpawn as unknown as typeof spawn,
    });
    try {
      expect(recordedArgs).not.toBeNull();
      const args = recordedArgs!;
      expect(args).toContain('--remote-debugging-address=127.0.0.1');
      expect(args.some((a) => a.startsWith('--remote-debugging-port='))).toBe(true);
      expect(args.some((a) => a === '--remote-debugging-address=0.0.0.0')).toBe(false);
    } finally {
      await handle.close();
    }
  }, 30_000);

  it('terminates the Chromium child process on close()', async () => {
    const handle = await launchCdpSession({ siteId: 'kill-test', dataDir });
    const pid = handle.pid;
    expect(pid).toBeDefined();
    // Process is alive immediately after launch.
    expect(() => process.kill(pid!, 0)).not.toThrow();
    await handle.close();
    // Allow the OS a moment to reap.
    await new Promise((r) => setTimeout(r, 250));
    expect(() => process.kill(pid!, 0)).toThrow();
  }, 30_000);

  it('passes opt-in stealth args when stealth=true (ADR-021)', async () => {
    let recordedArgs: readonly string[] | null = null;
    const recordingSpawn = (
      cmd: string,
      args?: readonly string[],
      options?: SpawnOptions,
    ): ChildProcess => {
      recordedArgs = args ?? [];
      return spawn(cmd, args ?? [], options ?? {});
    };

    const handle = await launchCdpSession({
      siteId: 'stealth',
      dataDir,
      stealth: true,
      spawnFn: recordingSpawn as unknown as typeof spawn,
    });
    try {
      expect(recordedArgs).not.toBeNull();
      expect(recordedArgs!).toContain('--disable-blink-features=AutomationControlled');
    } finally {
      await handle.close();
    }
  }, 30_000);

  it('omits stealth args by default (ADR-021 default posture is off)', async () => {
    let recordedArgs: readonly string[] | null = null;
    const recordingSpawn = (
      cmd: string,
      args?: readonly string[],
      options?: SpawnOptions,
    ): ChildProcess => {
      recordedArgs = args ?? [];
      return spawn(cmd, args ?? [], options ?? {});
    };

    const handle = await launchCdpSession({
      siteId: 'no-stealth',
      dataDir,
      spawnFn: recordingSpawn as unknown as typeof spawn,
    });
    try {
      expect(recordedArgs).not.toBeNull();
      expect(recordedArgs!).not.toContain('--disable-blink-features=AutomationControlled');
    } finally {
      await handle.close();
    }
  }, 30_000);
});
