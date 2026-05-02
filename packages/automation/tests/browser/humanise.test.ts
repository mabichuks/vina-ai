import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LISTING_MAX_MS,
  LISTING_MIN_MS,
  pause,
  sleepBetweenListings,
} from '../../src/browser/humanise.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('pause', () => {
  it('does not resolve before minMs has elapsed', async () => {
    let resolved = false;
    void pause(100, 200).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(resolved).toBe(false);
  });

  it('resolves by maxMs', async () => {
    let resolved = false;
    const p = pause(100, 200).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(resolved).toBe(true);
  });

  it('rejects with the signal reason when aborted mid-wait', async () => {
    const c = new AbortController();
    const p = pause(100, 200, c.signal);
    c.abort('shutdown');
    await expect(p).rejects.toBe('shutdown');
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const c = new AbortController();
    c.abort('early');
    await expect(pause(100, 200, c.signal)).rejects.toBe('early');
  });
});

describe('sleepBetweenListings', () => {
  it('exposes the listing-range constants and resolves within them', async () => {
    expect(LISTING_MIN_MS).toBe(4_000);
    expect(LISTING_MAX_MS).toBe(8_000);

    let resolved = false;
    const p = sleepBetweenListings().then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(LISTING_MAX_MS);
    await p;
    expect(resolved).toBe(true);
  });
});
