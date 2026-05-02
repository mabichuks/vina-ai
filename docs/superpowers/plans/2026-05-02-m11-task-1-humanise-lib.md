# M11 Task 1 — Humanise Lib Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the `humanise` timing library that the M11 LinkedIn adapter (and later browser-kind adapters) will call between actions and listings, with optional `AbortSignal` support so cooperative shutdown can interrupt mid-wait.

**Architecture:** Single small module exposing two pure async functions and two exported constants. No classes, no shared state, no logger. Tests use Vitest fake timers for deterministic timing assertions without real-time flake.

**Tech Stack:** TypeScript (strict, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`), Vitest, Node `AbortSignal`/`AbortController`. Lives in the existing `@vina/automation` package which was scaffolded by M11 Task 0 (`packages/automation/src/browser/launch.ts` is its sibling).

---

## File Structure

| Path | Responsibility |
|---|---|
| `packages/automation/src/browser/humanise.ts` (new) | The `pause` and `sleepBetweenListings` functions plus `LISTING_MIN_MS`/`LISTING_MAX_MS` constants |
| `packages/automation/src/index.ts` (modify) | Re-export the new public API alongside the existing `launchSiteContext` export |
| `packages/automation/tests/browser/humanise.test.ts` (new) | Five Vitest cases covering: pre-`min` non-resolution, by-`max` resolution, mid-wait abort, pre-aborted signal, listing-range constants |

This is a single-task plan because the design's whole surface is one 35-line module. Splitting into multiple commits would create artificial seams.

---

## Task 1: Humanise Lib

**Files:**
- Create: `packages/automation/src/browser/humanise.ts`
- Create: `packages/automation/tests/browser/humanise.test.ts`
- Modify: `packages/automation/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/automation/tests/browser/humanise.test.ts`:

```ts
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
    // Advance past the worst-case bound. The test is deterministic regardless
    // of what Math.random picked because we go past the maximum.
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/automation/tests/browser/humanise.test.ts`

Expected: FAIL — `Cannot find module '../../src/browser/humanise.js'` (or equivalent module-not-found error). All five cases should fail with the same import error before any implementation exists.

- [ ] **Step 3: Implement the module**

Create `packages/automation/src/browser/humanise.ts`:

```ts
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
```

- [ ] **Step 4: Re-export the public API**

Modify `packages/automation/src/index.ts`. The current contents (after M11 Task 0) are:

```ts
export { launchSiteContext, type LaunchSiteContextOptions } from './browser/launch.js';
```

Replace with:

```ts
export { launchSiteContext, type LaunchSiteContextOptions } from './browser/launch.js';
export {
  LISTING_MAX_MS,
  LISTING_MIN_MS,
  pause,
  sleepBetweenListings,
} from './browser/humanise.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run packages/automation/tests/browser/humanise.test.ts`

Expected: PASS — five tests in two `describe` blocks. Output should show `Tests  5 passed (5)`.

- [ ] **Step 6: Run the full repo verification**

Run each command and confirm clean exit (no errors, no warnings beyond the existing pino-pretty source-map noise):

```bash
pnpm --filter @vina/automation typecheck
pnpm --filter @vina/automation build
pnpm test
pnpm lint
```

Expected outputs:
- `typecheck`: clean exit (`tsc -p tsconfig.json --noEmit`)
- `build`: clean exit (`tsc -p tsconfig.build.json`); `packages/automation/dist/browser/humanise.js` exists
- `pnpm test`: `Tests  163 passed (163)` (158 from prior + 5 new) across 51 test files (50 + 1 new)
- `pnpm lint`: clean exit

If any of these fail, do NOT commit. Fix the failure and re-run all four.

- [ ] **Step 7: Commit**

```bash
git add packages/automation/src/browser/humanise.ts \
        packages/automation/src/index.ts \
        packages/automation/tests/browser/humanise.test.ts
git commit -m "feat(automation): humanise lib with abortable pause + sleepBetweenListings"
```

**IMPORTANT — commit message rules in this repo:**
- Use the exact message above: `feat(automation): humanise lib with abortable pause + sleepBetweenListings`
- Use plain `git commit -m "<message>"` form
- Do **NOT** include any "Claude" byline, "Co-Authored-By", "🤖 Generated with", or robot-attribution trailer. Pretend you are the user.

---

## Self-Review

**1. Spec coverage** (against `docs/superpowers/specs/2026-05-02-m11-humanise-lib-design.md`):

| Spec section | Covered by |
|---|---|
| Public API: `pause(minMs, maxMs, signal?)` | Step 3 (signature + body) |
| Public API: `sleepBetweenListings(signal?)` | Step 3 (sugar over `pause`) |
| Constants: `LISTING_MIN_MS = 4_000`, `LISTING_MAX_MS = 8_000` exported | Step 3 (top of module), Step 4 (re-export) |
| Implementation contract: uniform-random delay | Step 3 line `minMs + Math.floor(Math.random() * (maxMs - minMs + 1))` |
| Implementation contract: pre-abort rejects immediately with `signal.reason` | Step 3 line `if (signal?.aborted) { reject(signal.reason); return; }` |
| Implementation contract: mid-wait abort clears timer and rejects | Step 3 `onAbort` listener |
| Implementation contract: abort listener removed on normal resolution | Step 3 `signal?.removeEventListener('abort', onAbort)` in the timeout callback; `{ once: true }` covers the abort path |
| Test plan: pre-`min` non-resolution | Test case 1 |
| Test plan: by-`max` resolution | Test case 2 |
| Test plan: mid-wait abort | Test case 3 |
| Test plan: pre-aborted signal | Test case 4 |
| Test plan: listing-range constants exported and `sleepBetweenListings` resolves within | Test case 5 |
| File location: `packages/automation/src/browser/humanise.ts` | Step 3 |
| Public API re-exported via `@vina/automation` index | Step 4 |
| LOC estimate (~35 source, ~60 tests) | Source body is ~30 lines + comments; tests are 5 cases × ~10 lines each — within the estimate |

No spec requirement is uncovered.

**2. Placeholder scan:** No `TBD` / `TODO` / "implement later" / vague-error-handling markers anywhere in the plan. Every step shows the exact code or command.

**3. Type consistency:**
- `LISTING_MIN_MS` / `LISTING_MAX_MS` named identically in source (Step 3), re-export (Step 4), and tests (Step 1). Same for `pause` / `sleepBetweenListings`.
- The signal parameter is consistently typed `signal?: AbortSignal` in both function signatures and in the test setup (`new AbortController().signal`).
- `signal.reason` is referenced consistently in both code and assertion (`rejects.toBe('shutdown')`, `rejects.toBe('early')`).
- Test count claim in Step 6 (163 = 158 + 5) matches: design spec says 5 cases, plan defines exactly 5 `it` blocks.

**4. One tightness check:** the `onAbort` listener in Step 3's `pause` body does `signal?.addEventListener('abort', onAbort, { once: true })`. The `{ once: true }` option means Node auto-removes the listener after firing — so the explicit `removeEventListener` in the success path is the only manual cleanup needed. This is correct: if the pause resolves naturally, we want the listener gone so a later `signal.abort` doesn't try to reject an already-resolved promise (which would be a silent no-op but ugly). The plan is consistent.

No issues found.
