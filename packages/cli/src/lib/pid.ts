import fs from 'node:fs';
import path from 'node:path';
import { pidFile } from '../config.js';

export function readPidFile(): number | null {
  try {
    const raw = fs.readFileSync(pidFile, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function writePidFile(pid: number): void {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(pid), { mode: 0o600 });
}

export function deletePidFile(): void {
  try {
    fs.unlinkSync(pidFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Send signal 0 to test liveness — `kill(pid, 0)` raises ESRCH if the
 * process is gone, EPERM if it exists but we can't signal it.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
