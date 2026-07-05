import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildConfig } from '../src/config.js';

describe('buildConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-cfg-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('auto-creates all paths and emits a non-empty UUID-shaped bearer token', () => {
    const cfg = buildConfig({ dataDir: tmpDir });
    for (const dir of [cfg.dataDir, cfg.logsDir, cfg.filesDir, cfg.sessionsDir]) {
      expect(fs.existsSync(dir)).toBe(true);
    }
    expect(cfg.bearerToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(cfg.port).toBe(7341);
  });
});
