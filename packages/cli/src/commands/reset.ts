import readline from 'node:readline';
import { authedRequest, DaemonNotRunningError } from '../lib/api.js';
import { isProcessAlive, readPidFile } from '../lib/pid.js';
import { readStatus } from '../lib/status.js';

export interface ResetOptions {
  yes?: boolean;
}

async function confirm(): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(
      'This will delete all profile data, applications, and uploaded files. Type "yes" to continue: ',
      resolve,
    );
  });
  rl.close();
  return answer.trim().toLowerCase() === 'yes';
}

export async function resetCommand(options: ResetOptions = {}): Promise<number> {
  const pid = readPidFile();
  const status = readStatus();
  if (!pid || !isProcessAlive(pid) || !status) {
    process.stderr.write('Vina is not running. Run `vina start` first.\n');
    return 1;
  }

  if (!options.yes) {
    const ok = await confirm();
    if (!ok) {
      process.stdout.write('Cancelled.\n');
      return 0;
    }
  }

  try {
    await authedRequest(status.port, 'POST', '/api/system/reset', { confirm: 'reset' });
    process.stdout.write('All Vina data has been wiped.\n');
    return 0;
  } catch (err) {
    if (err instanceof DaemonNotRunningError) {
      process.stderr.write('Could not reach the daemon — is it still running?\n');
    } else {
      process.stderr.write(`Reset failed: ${(err as Error).message}\n`);
    }
    return 1;
  }
}
