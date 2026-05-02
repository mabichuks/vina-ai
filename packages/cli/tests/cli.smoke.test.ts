import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN = path.resolve(here, '..', 'dist', 'bin.js');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-cli-smoke-'));
});

afterEach(async () => {
  // Best-effort cleanup if a previous test crashed mid-run.
  if (fs.existsSync(path.join(tmpDir, 'vina.pid'))) {
    await runCli(['stop']).catch(() => undefined);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await exec('node', [CLI_BIN, ...args], {
      env: {
        ...process.env,
        VINA_DATA_DIR: tmpDir,
        // Bind to an ephemeral port so the test is robust against a real
        // daemon already running on 7341.
        VINA_PORT: '0',
        // Headless tests must not poke the OS keychain — the spawned daemon
        // would prompt or block. Force the file-backed master key path.
        VINA_DISABLE_KEYTAR: '1',
      },
      timeout: 30_000,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

describe('vina CLI smoke', () => {
  it.skipIf(!fs.existsSync(CLI_BIN))(
    'start --no-browser → status → fetch bootstrap → stop',
    async () => {
      const start = await runCli(['start', '--no-browser']);
      expect(start.code).toBe(0);
      expect(start.stdout).toMatch(/Vina started on http:\/\/127\.0\.0\.1:\d+/);

      const statusFile = path.join(tmpDir, 'vina.status');
      const status = JSON.parse(fs.readFileSync(statusFile, 'utf8')) as { port: number };

      const bootstrap = (await (
        await fetch(`http://127.0.0.1:${status.port}/api/bootstrap`)
      ).json()) as { token: string; onboarded: boolean };
      expect(bootstrap.token).toBeTruthy();
      expect(bootstrap.onboarded).toBe(false);

      const statusCmd = await runCli(['status']);
      expect(statusCmd.code).toBe(0);
      expect(statusCmd.stdout).toContain(`http://127.0.0.1:${status.port}`);

      const stop = await runCli(['stop']);
      expect(stop.code).toBe(0);
      expect(fs.existsSync(statusFile)).toBe(false);

      const stopAgain = await runCli(['stop']);
      expect(stopAgain.stdout).toContain('not running');
    },
    45_000,
  );
});
