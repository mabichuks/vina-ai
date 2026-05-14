import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../config.js';
import { authedRequest } from '../lib/api.js';
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

interface ChromiumStatus {
  available: boolean;
  executable_path: string | null;
  error?: string;
}

async function checkChromium(): Promise<CheckResult> {
  const status = readStatus();
  if (!status) {
    return {
      name: 'Chromium installed',
      ok: true,
      remediation: 'daemon not running (skipped)',
    };
  }
  try {
    const detail = await authedRequest<ChromiumStatus>(
      status.port,
      'GET',
      '/api/system/chromium',
    );
    if (detail.available && detail.executable_path && fs.existsSync(detail.executable_path)) {
      return { name: `Chromium installed (${detail.executable_path})`, ok: true };
    }
    return {
      name: 'Chromium installed',
      ok: false,
      remediation:
        detail.error ?? 'Run `pnpm exec playwright install chromium` in the Vina repo',
    };
  } catch (err) {
    return {
      name: 'Chromium installed',
      ok: false,
      remediation: (err as Error).message,
    };
  }
}

function checkLinkedInProfileDir(): CheckResult {
  const profileDir = path.join(dataDir, 'sessions', 'linkedin');
  if (fs.existsSync(profileDir)) {
    return { name: `LinkedIn profile dir present (${profileDir})`, ok: true };
  }
  return {
    name: 'LinkedIn profile dir present',
    ok: false,
    remediation: 'Run the wizard\'s Connect LinkedIn step (or Settings → Sites → Connect)',
  };
}

interface SystemStatusForDoctor {
  active_provider: { kind: string; model: string } | null;
  schedule_paused: boolean;
}

async function checkLlmProvider(): Promise<CheckResult> {
  const status = readStatus();
  if (!status) return { name: 'LLM provider configured', ok: true, remediation: 'daemon not running (skipped)' };
  try {
    const detail = await authedRequest<SystemStatusForDoctor>(
      status.port,
      'GET',
      '/api/system/status',
    );
    if (detail.active_provider) {
      return {
        name: `LLM provider configured (${detail.active_provider.kind}/${detail.active_provider.model})`,
        ok: true,
      };
    }
    return {
      name: 'LLM provider configured',
      ok: false,
      remediation: 'Add a provider and select it from the LLM Provider step or Settings',
    };
  } catch (err) {
    return {
      name: 'LLM provider configured',
      ok: false,
      remediation: (err as Error).message,
    };
  }
}

async function checkSchedulePaused(): Promise<CheckResult> {
  const status = readStatus();
  if (!status) return { name: 'Schedule not paused', ok: true, remediation: 'daemon not running (skipped)' };
  try {
    const detail = await authedRequest<SystemStatusForDoctor>(
      status.port,
      'GET',
      '/api/system/status',
    );
    return detail.schedule_paused
      ? {
          name: 'Schedule not paused',
          ok: false,
          remediation: 'Re-enable from Settings (it auto-pauses after 3 consecutive failures)',
        }
      : { name: 'Schedule not paused', ok: true };
  } catch (err) {
    return {
      name: 'Schedule not paused',
      ok: false,
      remediation: (err as Error).message,
    };
  }
}

interface AlertsListResponse {
  items: { id: string }[];
}

async function checkAlerts(): Promise<CheckResult> {
  const status = readStatus();
  if (!status) return { name: 'No unacknowledged alerts', ok: true, remediation: 'daemon not running (skipped)' };
  try {
    const list = await authedRequest<AlertsListResponse>(
      status.port,
      'GET',
      '/api/alerts?status=open',
    );
    if (list.items.length === 0) {
      return { name: 'No unacknowledged alerts', ok: true };
    }
    return {
      name: `No unacknowledged alerts (${list.items.length} open)`,
      ok: false,
      remediation: 'Open the Alerts page to review',
    };
  } catch (err) {
    return {
      name: 'No unacknowledged alerts',
      ok: false,
      remediation: (err as Error).message,
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
    checkDataDir(),
    checkDaemonReachable(),
    checkChromium(),
    checkLinkedInProfileDir(),
    checkLlmProvider(),
    checkSchedulePaused(),
    checkAlerts(),
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
