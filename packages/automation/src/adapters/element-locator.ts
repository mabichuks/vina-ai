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
    patterns: [
      /^submit application/i,
      /^submit easy apply/i,
      /^submit$/i,
      /^send application/i,
      /^send$/i,
      // Looser fallback for "Submit Application" / "Submit my application" /
      // anything containing the word submit. Combined with the
      // ADVANCE_ONLY_NAMES exclusion to avoid mis-matching Continue buttons.
      /submit/i,
    ],
  },
  advance: {
    roles: ['button'],
    patterns: [
      /^continue/i,
      /^next/i,
      /^review/i,
      /^save and continue/i,
      /continue applying/i,
    ],
  },
  dismiss: {
    roles: ['button'],
    patterns: [/^dismiss/i, /^close/i, /^cancel/i],
  },
};

/**
 * Names that should never be classified as a submit even if they
 * substring-match `/submit/i`. Used by the relaxed submit fallback so a
 * "Continue to review submission" button doesn't get clicked as the
 * final action.
 */
const SUBMIT_EXCLUSION = /^(continue|next|review|save and continue)/i;

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
 *
 * For `goal=submit`, names matching `SUBMIT_EXCLUSION` (Continue / Next /
 * Review / Save and continue) are skipped — the relaxed `/submit/i`
 * fallback otherwise grabs a "Continue to review submission" before the
 * real Submit screen.
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
    if (goal === 'submit' && SUBMIT_EXCLUSION.test(name)) return;
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
 * Return every interactive button in the tree (role=button/link) with
 * its accessible name. Used as diagnostic when no goal matches — the
 * caller logs the result so the user can see what buttons WERE on the
 * page when LinkedIn ate the expected one.
 */
export function listAllButtons(tree: UiTree): Array<{ role: string; name: string }> {
  const out: Array<{ role: string; name: string }> = [];
  walkTree(tree, (node) => {
    if (node.role === 'button' || node.role === 'link') {
      const name = node.name.trim();
      if (name) out.push({ role: node.role, name });
    }
  });
  return out;
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
export interface FindElementResult {
  locator: Locator;
  tier: 'selector' | 'a11y';
}

export interface FindElementOptions {
  /**
   * When the locator can't find the goal, capture a diagnostic snapshot
   * of every visible button on the page and pass it to this callback.
   * Used by the apply graph to log what WAS on the page when submit
   * couldn't be located.
   */
  onMiss?: (diagnostic: { goal: ButtonGoal; buttons: Array<{ role: string; name: string }> }) => void;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function findElementByGoal(
  page: Page,
  goal: ButtonGoal,
  selectors: readonly string[],
  options: FindElementOptions = {},
): Promise<FindElementResult | null> {
  const viaSelectors = await firstVisibleFromSelectors(page, selectors);
  if (viaSelectors) return { locator: viaSelectors, tier: 'selector' };

  const tree = await takeSnapshot(page);
  const node = findGoalNodeInTree(tree, goal);
  if (!node) {
    if (options.onMiss) {
      options.onMiss({ goal, buttons: listAllButtons(tree) });
    }
    return null;
  }
  // Use a regex tolerant of trailing whitespace — Chrome's accname calc
  // sometimes returns "Submit application " with a trailing space, which
  // breaks Playwright's `exact: true` string match against the trimmed
  // snapshot name. The regex anchors and allows trailing whitespace.
  const nameRegex = new RegExp(`^${escapeForRegex(node.name)}\\s*$`);
  const locator = page
    .getByRole(node.role as Parameters<Page['getByRole']>[0], {
      name: nameRegex,
    })
    .first();
  return { locator, tier: 'a11y' };
}
