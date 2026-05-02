import fs from 'node:fs';
import { dataDir } from '../config.js';
import { isProcessAlive, readPidFile } from '../lib/pid.js';
import { readStatus } from '../lib/status.js';

export interface CheckResult {
  name: string;
  ok: boolean;
  remediation?: string;
}

function checkNodeVersion(): CheckResult {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  return major >= 20
    ? { name: `Node ≥ 20 (running ${process.versions.node})`, ok: true }
    : {
        name: `Node ≥ 20 (running ${process.versions.node})`,
        ok: false,
        remediation: 'Install Node 20 LTS or newer (e.g. via nvm or fnm)',
      };
}

function checkPlaywright(): CheckResult {
  try {
    // Playwright isn't a CLI dep — only the automation package depends on it.
    // For now we just confirm the package can be resolved from somewhere on
    // disk; real "are browsers installed?" lives in the automation package and
    // wires in once Phase 11 lands.
    import.meta.resolve('playwright');
    return { name: 'Playwright resolvable', ok: true };
  } catch {
    return {
      name: 'Playwright resolvable',
      ok: false,
      remediation: 'Run `pnpm install` and (later) `pnpm exec playwright install chromium`',
    };
  }
}

function checkDataDir(): CheckResult {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.accessSync(dataDir, fs.constants.W_OK);
    return { name: `Data directory writable (${dataDir})`, ok: true };
  } catch (err) {
    return {
      name: `Data directory writable (${dataDir})`,
      ok: false,
      remediation: `Fix permissions on ${dataDir}: ${(err as Error).message}`,
    };
  }
}

async function checkDaemonReachable(): Promise<CheckResult> {
  const pid = readPidFile();
  const status = readStatus();
  if (!pid || !isProcessAlive(pid) || !status) {
    return { name: 'Daemon reachable', ok: true, remediation: 'not running (skipped)' };
  }
  try {
    const res = await fetch(`http://127.0.0.1:${status.port}/api/bootstrap`);
    return res.ok
      ? { name: `Daemon reachable on port ${status.port}`, ok: true }
      : {
          name: `Daemon reachable on port ${status.port}`,
          ok: false,
          remediation: `HTTP ${res.status}`,
        };
  } catch (err) {
    return {
      name: `Daemon reachable on port ${status.port}`,
      ok: false,
      remediation: (err as Error).message,
    };
  }
}

export async function doctorCommand(): Promise<number> {
  const checks: (CheckResult | Promise<CheckResult>)[] = [
    checkNodeVersion(),
    checkPlaywright(),
    checkDataDir(),
    checkDaemonReachable(),
  ];
  const results = await Promise.all(checks);

  let allOk = true;
  for (const r of results) {
    const tag = r.ok ? 'PASS' : 'FAIL';
    process.stdout.write(`  [${tag}] ${r.name}\n`);
    if (r.remediation) process.stdout.write(`         ↳ ${r.remediation}\n`);
    if (!r.ok) allOk = false;
  }
  return allOk ? 0 : 1;
}
