import { describe, it, expect, beforeEach } from 'vitest';
import { useSearchProgressStore } from '../../src/store/search-progress-store.js';

beforeEach(() => useSearchProgressStore.getState().reset());

describe('search-progress-store — currentTaskId + cancellation', () => {
  it('beginDiscovering({ taskId }) sets currentTaskId', () => {
    useSearchProgressStore.getState().beginDiscovering({ taskId: 't1' });
    expect(useSearchProgressStore.getState().currentTaskId).toBe('t1');
  });

  it('beginDiscovering() without taskId leaves currentTaskId null', () => {
    useSearchProgressStore.getState().beginDiscovering();
    expect(useSearchProgressStore.getState().currentTaskId).toBe(null);
  });

  it('reset clears currentTaskId and wasCancelled', () => {
    useSearchProgressStore.getState().beginDiscovering({ taskId: 't1' });
    useSearchProgressStore.getState().markCancelled();
    useSearchProgressStore.getState().reset();
    expect(useSearchProgressStore.getState().currentTaskId).toBe(null);
    expect(useSearchProgressStore.getState().wasCancelled).toBe(false);
  });

  it('markCancelled sets phase=done and wasCancelled=true', () => {
    useSearchProgressStore.getState().beginDiscovering({ taskId: 't1' });
    useSearchProgressStore.getState().markCancelled();
    expect(useSearchProgressStore.getState().phase).toBe('done');
    expect(useSearchProgressStore.getState().wasCancelled).toBe(true);
  });

  it('beginDiscovering clears wasCancelled from a prior cancel', () => {
    useSearchProgressStore.getState().beginDiscovering({ taskId: 't1' });
    useSearchProgressStore.getState().markCancelled();
    useSearchProgressStore.getState().beginDiscovering({ taskId: 't2' });
    expect(useSearchProgressStore.getState().wasCancelled).toBe(false);
    expect(useSearchProgressStore.getState().currentTaskId).toBe('t2');
  });
});
