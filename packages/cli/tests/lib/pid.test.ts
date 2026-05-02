import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-pid-'));
  process.env['VINA_DATA_DIR'] = tmpDir;
  // Force config + pid to re-evaluate against the new VINA_DATA_DIR.
  vi.resetModules();
});

afterEach(() => {
  delete process.env['VINA_DATA_DIR'];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('pid utilities', () => {
  it('write → read round-trips and delete clears', async () => {
    const { readPidFile, writePidFile, deletePidFile } = await import('../../src/lib/pid.js');
    expect(readPidFile()).toBeNull();

    writePidFile(12345);
    expect(readPidFile()).toBe(12345);

    deletePidFile();
    expect(readPidFile()).toBeNull();

    // delete on missing file is a no-op
    expect(() => deletePidFile()).not.toThrow();
  });

  it('isProcessAlive returns true for self, false for a stale PID', async () => {
    const { isProcessAlive } = await import('../../src/lib/pid.js');
    expect(isProcessAlive(process.pid)).toBe(true);

    // 0x7FFFFFFE is well above any realistic concurrent PID — vanishingly
    // unlikely to map to a real process on the test machine.
    expect(isProcessAlive(0x7ffffffe)).toBe(false);
  });
});
