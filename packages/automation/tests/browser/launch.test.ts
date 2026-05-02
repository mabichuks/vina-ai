import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launchSiteContext } from '../../src/browser/launch.js';

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vina-launch-test-'));
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('launchSiteContext', () => {
  it('launches a persistent context against bundled Chromium', async () => {
    const ctx = await launchSiteContext({ siteId: 'unit', dataDir });
    try {
      const page = await ctx.newPage();
      await page.goto('about:blank');
      expect(await page.title()).toBe('');
    } finally {
      await ctx.close();
    }
  }, 30_000);

  it('creates the profile dir at <dataDir>/sessions/<siteId>/ and writes profile files', async () => {
    const ctx = await launchSiteContext({ siteId: 'profile-shape', dataDir });
    await ctx.close();

    const profileDir = path.join(dataDir, 'sessions', 'profile-shape');
    const stat = await fs.stat(profileDir);
    expect(stat.isDirectory()).toBe(true);

    // Chromium writes its own files (Default/, Cookies, etc.) on close.
    // Don't pin filenames — they vary by build — just confirm the dir is non-empty.
    const entries = await fs.readdir(profileDir);
    expect(entries.length).toBeGreaterThan(0);
  }, 30_000);
});
