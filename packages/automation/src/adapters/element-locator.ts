import type { Locator, Page } from 'playwright';
import { takeSnapshot, type UiNode, type UiTree } from '../snapshot/snapshot.js';
import { walkTree } from '../snapshot/refs.js';

/**
 * What we're looking for. Goal names are stable strings the apply graph
 * uses across adapters; the locator translates them into accessibility-tree
 * matches when CSS selectors miss (ADR-022).
 */
export type ButtonGoal =
  | 'easy_apply'
  | 'submit'
  | 'advance'
  | 'dismiss';

/**
 * Accessibility-name patterns we accept for each goal. Case-insensitive
 * substring or regex test against `UiNode.name`. The interactive `role`
 * is restricted to clickable kinds.
 */
const GOAL_HEURISTICS: Record<ButtonGoal, { roles: ReadonlyArray<string>; patterns: ReadonlyArray<RegExp> }> = {
  easy_apply: {
    roles: ['button', 'link'],
    patterns: [/easy apply/i, /quick apply/i, /^apply$/i],
  },
  submit: {
    roles: ['button'],
    patterns: [/^submit application/i, /^submit$/i, /^send application/i, /^send$/i],
  },
  advance: {
    roles: ['button'],
    patterns: [/^continue/i, /^next/i, /^review/i, /^save and continue/i],
  },
  dismiss: {
    roles: ['button'],
    patterns: [/^dismiss/i, /^close/i, /^cancel/i],
  },
};

/**
 * Pick the first visible locator from a CSS selector list. Cheap and
 * deterministic — same shape the LinkedIn discovery code uses for apply-
 * method detection. Falls back to absent-but-visible across the list.
 */
async function firstVisibleFromSelectors(
  page: Page,
  selectors: readonly string[],
): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) return locator;
  }
  return null;
}

/**
 * Walk a UiTree and find the first node whose role + name match a goal's
 * accessibility heuristics. Used when CSS selectors miss — the
 * accessibility tree survives class-name churn (ADR-022).
 */
export function findGoalNodeInTree(tree: UiTree, goal: ButtonGoal): UiNode | null {
  const { roles, patterns } = GOAL_HEURISTICS[goal];
  const allowed = new Set(roles);
  let found: UiNode | null = null;
  walkTree(tree, (node) => {
    if (found) return;
    if (!allowed.has(node.role)) return;
    const name = node.name.trim();
    if (!name) return;
    for (const pattern of patterns) {
      if (pattern.test(name)) {
        found = node;
        return;
      }
    }
  });
  return found;
}

/**
 * Two-tier element locator. Tries CSS selectors first (cheap), falls
 * back to accessibility-name matching against a fresh snapshot
 * (deterministic, survives selector drift).
 *
 * Both tiers return a Playwright `Locator`. Callers can `.click()` /
 * `.fill()` / etc on the result. The locator yielded by the a11y tier
 * uses Playwright's `getByRole(role, { name, exact: true })` — the same
 * resolution path `actOnSession` uses.
 *
 * Returns null when no tier matched. The apply graph's role is to
 * decide between alert-and-stop and LLM-tier fallback at that point.
 */
export async function findElementByGoal(
  page: Page,
  goal: ButtonGoal,
  selectors: readonly string[],
): Promise<{ locator: Locator; tier: 'selector' | 'a11y' } | null> {
  const viaSelectors = await firstVisibleFromSelectors(page, selectors);
  if (viaSelectors) return { locator: viaSelectors, tier: 'selector' };

  const tree = await takeSnapshot(page);
  const node = findGoalNodeInTree(tree, goal);
  if (!node) return null;
  const locator = page
    .getByRole(node.role as Parameters<Page['getByRole']>[0], {
      name: node.name,
      exact: true,
    })
    .first();
  return { locator, tier: 'a11y' };
}
