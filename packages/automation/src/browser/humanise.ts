/**
 * Realistic-delay helpers for browser-kind adapters. Honours ADR-013 — the
 * point is politeness (avoid pounding sites with zero-delay scripts), not
 * fingerprint masking. See docs/browser-automation.md §10.
 *
 * Both functions accept an optional `AbortSignal` so the worker's
 * cooperative-shutdown signal can interrupt mid-wait. Aborting rejects the
 * promise with `signal.reason` (matches Node's `signal.throwIfAborted()`
 * semantics — we don't impose our own error type).
 */

export const LISTING_MIN_MS = 4_000;
export const LISTING_MAX_MS = 8_000;

/**
 * Pause for a uniform-random duration between `minMs` and `maxMs`
 * (inclusive). The caller picks sensible bounds; there is no input
 * validation. If `signal` is aborted before or during the pause, the
 * returned promise rejects with `signal.reason`.
 */
export function pause(minMs: number, maxMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const delay = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Pause between processing two consecutive job listings — sugar for
 * `pause(LISTING_MIN_MS, LISTING_MAX_MS, signal)`. Named so adapter call
 * sites read intentionally.
 */
export function sleepBetweenListings(signal?: AbortSignal): Promise<void> {
  return pause(LISTING_MIN_MS, LISTING_MAX_MS, signal);
}
