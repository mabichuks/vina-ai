import { createLogger } from '@vina/shared';

const log = createLogger('queue.active-tasks');

interface ActiveEntry {
  signal: AbortSignal;
  abort: () => void;
  site_id: string;
}

const activeTasks = new Map<string, ActiveEntry>();

export function registerActiveTask(taskId: string, site_id: string): AbortSignal {
  if (activeTasks.has(taskId)) {
    log.warn({ task_id: taskId }, 'registerActiveTask: replacing existing entry');
    activeTasks.delete(taskId);
  }
  const ac = new AbortController();
  activeTasks.set(taskId, { signal: ac.signal, abort: () => ac.abort(), site_id });
  return ac.signal;
}

export function unregisterActiveTask(taskId: string): void {
  activeTasks.delete(taskId);
}

export function cancelActiveTask(taskId: string): boolean {
  const entry = activeTasks.get(taskId);
  if (!entry) return false;
  entry.abort();
  activeTasks.delete(taskId);
  return true;
}

export function cancelTasksForSite(site_id: string): number {
  let n = 0;
  for (const [id, entry] of activeTasks) {
    if (entry.site_id === site_id) {
      entry.abort();
      activeTasks.delete(id);
      n += 1;
    }
  }
  return n;
}

/** Test seam. Not exported through the package index. */
export function _resetActiveTasksForTests(): void {
  activeTasks.clear();
}
