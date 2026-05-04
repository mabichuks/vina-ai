import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserManager } from '../../src/browser/manager.js';

// Mock the launch module so individual tests can override the function's
// return value. By default we passthrough to the real implementation.
vi.mock('../../src/browser/launch.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/browser/launch.js')>(
    '../../src/browser/launch.js',
  );
  return { ...actual };
});

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vina-mgr-test-'));
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('BrowserManager', () => {
  it('caches contexts: repeat getContext returns the same instance', async () => {
    const mgr = createBrowserManager({ dataDir });
    try {
      const a = await mgr.getContext('site-a');
      const b = await mgr.getContext('site-a');
      expect(a).toBe(b);
    } finally {
      await mgr.closeAll();
    }
  }, 30_000);

  it('closeContext removes from cache so next getContext launches fresh', async () => {
    const mgr = createBrowserManager({ dataDir });
    try {
      const first = await mgr.getContext('site-a');
      await mgr.closeContext('site-a');
      const second = await mgr.getContext('site-a');
      expect(first).not.toBe(second);
    } finally {
      await mgr.closeAll();
    }
  }, 30_000);

  it('closeAll closes every cached context', async () => {
    const mgr = createBrowserManager({ dataDir });
    const a = await mgr.getContext('site-a');
    const b = await mgr.getContext('site-b');
    expect(a).not.toBe(b);
    await mgr.closeAll();
    // After closeAll, getting again returns a fresh context.
    const a2 = await mgr.getContext('site-a');
    try {
      expect(a2).not.toBe(a);
    } finally {
      await mgr.closeAll();
    }
  }, 30_000);

  it('concurrent getContext calls dedup to a single launch', async () => {
    const mgr = createBrowserManager({ dataDir });
    try {
      const [a, b, c] = await Promise.all([
        mgr.getContext('site-a'),
        mgr.getContext('site-a'),
        mgr.getContext('site-a'),
      ]);
      expect(a).toBe(b);
      expect(b).toBe(c);
    } finally {
      await mgr.closeAll();
    }
  }, 30_000);

  it('evicts a failed launch from the cache so the next call retries', async () => {
    // First call: force a launch failure via mock.
    const launchMock = vi.spyOn(
      await import('../../src/browser/launch.js'),
      'launchSiteContext',
    );
    launchMock.mockRejectedValueOnce(new Error('chromium missing'));

    const mgr = createBrowserManager({ dataDir });
    await expect(mgr.getContext('site-a')).rejects.toThrow('chromium missing');

    // Second call: mock not configured for this call, falls through to real
    // launch and should succeed.
    launchMock.mockRestore();
    try {
      const ctx = await mgr.getContext('site-a');
      expect(ctx).toBeDefined();
    } finally {
      await mgr.closeAll();
    }
  }, 30_000);
});
