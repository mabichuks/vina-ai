import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { logFile, logsDir } from '../config.js';
import { openBrowser } from '../lib/browser.js';
import { isProcessAlive, readPidFile, writePidFile } from '../lib/pid.js';
import { readStatus, waitForStatus } from '../lib/status.js';

export interface StartOptions {
  noBrowser?: boolean;
}

export async function startCommand(options: StartOptions = {}): Promise<number> {
  const existing = readPidFile();
  if (existing && isProcessAlive(existing)) {
    // Re-running `vina start` against a live daemon is a "show me the UI"
    // request, not an error. Open the browser (unless suppressed) and exit 0.
    const status = readStatus();
    const port = status?.port;
    const url = port ? `http://127.0.0.1:${port}` : null;
    process.stdout.write(
      url
        ? `Vina is already running at ${url} (pid ${existing}).\n`
        : `Vina is already running (pid ${existing}).\n`,
    );
    if (url) await openBrowser(url, { skip: options.noBrowser });
    return 0;
  }

  fs.mkdirSync(logsDir, { recursive: true });
  const out = fs.openSync(logFile, 'a');

  // Resolve the server's main entry via Node module resolution so this works
  // both in dev (workspace symlinks) and once installed.
  const serverEntry = fileURLToPath(import.meta.resolve('@vina/server/main'));

  const child = spawn(process.execPath, [serverEntry], {
    detached: true,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      // JSON logs in the file when run via the CLI; the dev runner stays pretty.
      NODE_ENV: process.env['NODE_ENV'] ?? 'production',
    },
  });
  child.unref();

  if (typeof child.pid !== 'number') {
    throw new Error('Failed to spawn the daemon');
  }
  writePidFile(child.pid);

  let status;
  try {
    status = await waitForStatus(15_000);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\nCheck the log: ${logFile}\n`);
    return 1;
  }

  const url = `http://127.0.0.1:${status.port}`;
  process.stdout.write(`Vina started on ${url} (pid ${status.pid}, version ${status.version})\n`);
  process.stdout.write(`Logs: ${path.relative(process.cwd(), logFile) || logFile}\n`);

  await openBrowser(url, { skip: options.noBrowser });
  return 0;
}
