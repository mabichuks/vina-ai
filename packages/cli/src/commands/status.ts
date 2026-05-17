import { authedRequest } from '../lib/api.js';
import { isProcessAlive, readPidFile } from '../lib/pid.js';
import { readStatus } from '../lib/status.js';

interface SystemStatus {
  version: string;
  started_at: string;
  scheduler: { running: boolean };
  queue: { pending: number; running: number; kinds?: Record<string, number> };
  ready_to_apply_count?: number;
  active_provider: { kind: string; model: string } | null;
  linkedin_connected: boolean;
  linkedin_last_search_at: string | null;
  google_state: 'not_configured' | 'connected' | 'key_invalid' | 'quota_exhausted';
  google_last_search_at: string | null;
  schedule_paused: boolean;
}

export async function statusCommand(): Promise<number> {
  const pid = readPidFile();
  const status = readStatus();
  if (!pid || !isProcessAlive(pid) || !status) {
    process.stdout.write('Vina is not running.\n');
    return 0;
  }

  process.stdout.write(`Vina v${status.version} on http://127.0.0.1:${status.port} (pid ${pid})\n`);
  process.stdout.write(`Started: ${status.started_at}\n`);

  // Best-effort: ask the daemon for richer info. If it's mid-shutdown or the
  // route is unreachable, just print the basics.
  try {
    const detail = await authedRequest<SystemStatus>(status.port, 'GET', '/api/system/status');
    process.stdout.write(`Scheduler: ${detail.scheduler.running ? 'running' : 'paused'}\n`);
    process.stdout.write(
      `Queue: ${detail.queue.pending} pending, ${detail.queue.running} running\n`,
    );
    const prepDepth = detail.queue.kinds?.['prepare_manual_apply'] ?? 0;
    process.stdout.write(`Manual-apply queue: ${prepDepth} pending\n`);
    process.stdout.write(`Ready to apply: ${detail.ready_to_apply_count ?? 0}\n`);
    process.stdout.write(
      `Provider: ${detail.active_provider ? `${detail.active_provider.kind}/${detail.active_provider.model}` : 'none configured'}\n`,
    );
    process.stdout.write(
      `LinkedIn: ${detail.linkedin_connected ? 'connected' : 'not connected'}\n`,
    );
    process.stdout.write(
      `Last search: ${detail.linkedin_last_search_at ?? 'never'}\n`,
    );
    const googleLabel = (() => {
      switch (detail.google_state) {
        case 'connected':
          return detail.google_last_search_at
            ? `connected (last search ${detail.google_last_search_at})`
            : 'connected';
        case 'key_invalid': return 'key invalid';
        case 'quota_exhausted': return 'quota exhausted';
        default: return 'not configured';
      }
    })();
    process.stdout.write(`Google Jobs: ${googleLabel}\n`);
    if (detail.schedule_paused) {
      process.stdout.write('⚠ Schedule is paused\n');
    }
  } catch (err) {
    process.stderr.write(`Could not reach daemon: ${(err as Error).message}\n`);
  }
  return 0;
}
