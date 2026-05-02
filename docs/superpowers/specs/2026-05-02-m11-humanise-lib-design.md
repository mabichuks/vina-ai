# M11 Task 1 — Humanise Lib Design

## Goal

A small library exposing two timing primitives that adapters call to maintain realistic delays between automated actions. Honours [ADR-013](../../decisions.md#adr-013-no-fingerprint-masking-no-anti-detection-beyond-legitimate-session) — this is *politeness*, not deception.

## Scope

**In:**

- A `pause(minMs, maxMs)` for the 200–600ms inter-action delays the spec calls for in [browser-automation.md §10](../../browser-automation.md#10-anti-detection-practices).
- A `sleepBetweenListings()` for the 4–8s inter-listing delays, with the bounds exported as constants.
- Both functions accept an optional `AbortSignal` so handler shutdown can interrupt mid-wait — matches the cooperative-shutdown discipline established by the per-handler timeouts in [`packages/server/src/queue/timeouts.ts`](../../../packages/server/src/queue/timeouts.ts).

**Out** (deferred to M11 Tasks 2+ or later milestones):

- `humanType(locator, text)` — Playwright's `locator.type(text, { delay })` already supports per-keystroke jitter; adapters can pass `delay: random(20, 80)` at the call site. Extract a wrapper if M15's form-walker repeats the pattern.
- Mouse-wheel scroll helpers — Playwright's `page.mouse.wheel()` plus `await pause()` is enough; revisit if adapters want a unified `humanScroll()`.
- Click-with-settle helpers — Playwright's actionability already retries until ready.
- Per-site daily application caps — that's a counter, not timing. Lives in the apply graph or worker layer (M15+).

## File location

`packages/automation/src/browser/humanise.ts` (matches the folder layout in [browser-automation.md §1](../../browser-automation.md#1-folder-layout)).

## Public API

```ts
/**
 * Pause for a uniform-random duration between `minMs` and `maxMs`. The
 * caller is responsible for picking sensible bounds — there is no input
 * validation. If `signal` is supplied and aborts (either before or during
 * the pause), the returned promise rejects with `signal.reason`.
 */
export async function pause(
  minMs: number,
  maxMs: number,
  signal?: AbortSignal,
): Promise<void>;

export const LISTING_MIN_MS = 4_000;
export const LISTING_MAX_MS = 8_000;

/**
 * Pause between processing two consecutive job listings. Equivalent to
 * `pause(LISTING_MIN_MS, LISTING_MAX_MS, signal)` — exists as a named
 * function so adapters and call-sites read intentionally.
 */
export async function sleepBetweenListings(signal?: AbortSignal): Promise<void>;
```

## Implementation contract

- `pause` picks `delay = minMs + Math.floor(Math.random() * (maxMs - minMs + 1))` (uniform inclusive). The exact distribution doesn't matter; only that the floor and ceiling are honoured.
- If `signal?.aborted` is `true` at entry, reject immediately with `signal.reason` (matches Node's `signal.throwIfAborted()` semantics).
- Otherwise schedule a `setTimeout(resolve, delay)` and attach a one-shot abort listener that calls `clearTimeout` + `reject(signal.reason)` and removes itself.
- On normal resolution, the abort listener must be removed too (no leak if the same signal is reused across calls).
- `sleepBetweenListings(signal)` returns `pause(LISTING_MIN_MS, LISTING_MAX_MS, signal)`.

The `signal.reason` plumbing means callers writing `controller.abort('shutdown')` get back a string `'shutdown'`; callers writing `controller.abort()` get the default `DOMException('This operation was aborted', 'AbortError')`. We don't impose our own error type — let the adapter and the worker agree on what they pass.

## Test plan

`packages/automation/tests/browser/humanise.test.ts` using Vitest. `beforeEach` calls `vi.useFakeTimers()`; `afterEach` calls `vi.useRealTimers()`. All time-advance calls use `vi.advanceTimersByTimeAsync` so microtasks (promise resolutions) flush properly between advances.

The "is the promise still pending" pattern uses a resolved-flag to avoid race conditions with microtask timing:

```ts
let resolved = false;
const p = pause(100, 200).then(() => { resolved = true; });
await vi.advanceTimersByTimeAsync(99);
expect(resolved).toBe(false);
await vi.advanceTimersByTimeAsync(101);
await p;
expect(resolved).toBe(true);
```

| # | Case | Approach |
|---|---|---|
| 1 | `pause` does not resolve before `minMs` | resolved-flag pattern above; assert flag is `false` after advancing 99ms (with min=100) |
| 2 | `pause` resolves by `maxMs` | continue from #1: advance another 101ms (total 200), `await p`, assert flag is `true` |
| 3 | `pause` rejects when signal aborts mid-wait | `const c = new AbortController(); const p = pause(100, 200, c.signal); c.abort('shutdown'); await expect(p).rejects.toBe('shutdown')` |
| 4 | `pause` rejects immediately if signal is pre-aborted | `const c = new AbortController(); c.abort('early'); await expect(pause(100, 200, c.signal)).rejects.toBe('early')` (no timer advance needed) |
| 5 | `sleepBetweenListings` resolves within the listing range | resolved-flag pattern; advance `LISTING_MAX_MS` and assert resolved. Also assert the constants are exported and equal `4_000` / `8_000` |

No seeded RNG — the fake-timers approach makes the test deterministic by advancing past the worst-case bound regardless of random choice. Real-time test flakes are eliminated because no real time elapses.

## Code organisation

Single module, two exports, two exported constants. No class, no shared state, no logger. Pure-by-construction. Will live in `browser/` alongside the M11 Task 0 `launch.ts` helper.

## What this unblocks for M11

- **Task 2 (BrowserManager)** — no direct use, but the manager will pass its shutdown `AbortSignal` to whatever it spawns, and that signal flows into adapter code that calls `pause`.
- **Task 4 (apply-method detection)** — calls `pause(200, 600)` between DOM probes when needed.
- **Task 7 (LinkedIn adapter)** — biggest consumer. `await pause(200, 600)` between actions, `await sleepBetweenListings()` between iterations of the search async iterator.
- **Task 9 (search handler replacement)** — threads the worker's shutdown signal through to the adapter so a graceful stop interrupts mid-iteration pauses.

## Integration debt

The worker today (`packages/server/src/queue/worker.ts`) does not pass an `AbortSignal` into handler calls — `runOne` invokes `handler(payload)` with no second argument. That's a separate change, planned for the M11 Task 9 search-handler replacement (or a small earlier task to extend the `TaskHandler` signature). Until then, adapters call `pause(...)` without a signal and rely on the per-kind handler timeout (`DEFAULT_TIMEOUTS_MS.search = 5min`) as a backstop. The optional signal is a forward-compatible hook so we don't need to change the humanise API when the wiring lands.

## LOC estimate

- Source: ~35 lines (function bodies + JSDoc + constants)
- Tests: ~60 lines (5 cases with shared `beforeEach`/`afterEach` for fake-timers)
