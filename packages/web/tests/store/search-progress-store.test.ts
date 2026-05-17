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

describe('search-progress-store — pre-scoring race buffer', () => {
  it('buffers score completions that arrive during discovering and folds them into scoredCount on beginScoring', () => {
    const s = useSearchProgressStore.getState();
    s.beginDiscovering({ taskId: 't1' });
    // Two score tasks finish before the search handler emits search:completed.
    s.countScored(1);
    s.countScored(1);
    expect(useSearchProgressStore.getState().scoredCount).toBe(0);
    expect(useSearchProgressStore.getState().pendingScoreCount).toBe(2);
    // Now search:completed lands: target = 5, two already counted.
    s.beginScoring(5);
    expect(useSearchProgressStore.getState().scoredCount).toBe(2);
    expect(useSearchProgressStore.getState().totalToScore).toBe(5);
    expect(useSearchProgressStore.getState().pendingScoreCount).toBe(0);
    expect(useSearchProgressStore.getState().phase).toBe('scoring');
  });

  it('skips straight to done if the buffered count already meets the target', () => {
    const s = useSearchProgressStore.getState();
    s.beginDiscovering();
    s.countScored(1);
    s.countScored(1);
    s.countScored(1);
    s.beginScoring(3);
    expect(useSearchProgressStore.getState().phase).toBe('done');
    expect(useSearchProgressStore.getState().scoredCount).toBe(3);
  });

  it('discovering-phase countDiscoveredListings is unaffected by countScored buffer', () => {
    const s = useSearchProgressStore.getState();
    s.beginDiscovering();
    s.countDiscoveredListings(5);
    s.countScored(2);
    expect(useSearchProgressStore.getState().listingsFound).toBe(5);
    expect(useSearchProgressStore.getState().pendingScoreCount).toBe(2);
  });
});
