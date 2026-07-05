import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootServer, type BootedServer } from '../../src/main.js';

let booted: BootedServer | null = null;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-smoke-'));
});

afterEach(async () => {
  if (booted) {
    await booted.shutdown();
    booted = null;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('server smoke', () => {
  it('boots, serves /api/bootstrap and /api/system/status, writes and removes vina.status', async () => {
    booted = await bootServer({ port: 0, dataDir: tmpDir });
    expect(booted.port).toBeGreaterThan(0);
    expect(fs.existsSync(booted.config.statusFile)).toBe(true);

    const base = `http://127.0.0.1:${booted.port}`;
    const bootstrap = (await (await fetch(`${base}/api/bootstrap`)).json()) as {
      token: string;
      onboarded: boolean;
      version: string;
    };
    expect(bootstrap.token).toBe(booted.config.bearerToken);
    expect(bootstrap.onboarded).toBe(false);

    const status = await fetch(`${base}/api/system/status`, {
      headers: { authorization: `Bearer ${booted.config.bearerToken}` },
    });
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as { sources: unknown[] };
    expect(statusBody.sources).toHaveLength(3);

    await booted.shutdown();
    booted = null;
    expect(fs.existsSync(path.join(tmpDir, 'vina.status'))).toBe(false);
  });
});
