import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { bootServer } from '../../src/main.js';

describe('bootServer wires BrowserManager', () => {
  it('exposes browserManager on the booted handle and closes it on shutdown', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-bm-'));
    const booted = await bootServer({ port: 0, dataDir: tmp });
    expect(typeof booted.browserManager.getContext).toBe('function');
    expect(typeof booted.browserManager.closeAll).toBe('function');
    await booted.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
