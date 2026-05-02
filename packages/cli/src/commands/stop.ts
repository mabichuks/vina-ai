import { deletePidFile, isProcessAlive, readPidFile } from '../lib/pid.js';

export async function stopCommand(): Promise<number> {
  const pid = readPidFile();
  if (!pid || !isProcessAlive(pid)) {
    if (pid) deletePidFile(); // stale
    process.stdout.write('Vina is not running.\n');
    return 0;
  }

  process.stdout.write(`Stopping Vina (pid ${pid})…\n`);
  process.kill(pid, 'SIGTERM');

  // Wait up to 30s for graceful exit, then SIGKILL.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      deletePidFile();
      process.stdout.write('Stopped.\n');
      return 0;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  process.stderr.write('Graceful shutdown timed out; forcing.\n');
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
  deletePidFile();
  return 0;
}
