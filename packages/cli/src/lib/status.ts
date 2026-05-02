import fs from 'node:fs';
import { statusFile, type DaemonStatus } from '../config.js';

export function readStatus(): DaemonStatus | null {
  try {
    const raw = fs.readFileSync(statusFile, 'utf8');
    return JSON.parse(raw) as DaemonStatus;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Poll until the status file appears or the timeout expires. */
export async function waitForStatus(timeoutMs = 10_000): Promise<DaemonStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = readStatus();
    if (status) return status;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for the daemon to start`);
}
