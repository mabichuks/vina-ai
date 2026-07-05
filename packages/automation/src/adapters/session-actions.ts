import type { Page } from 'playwright';
import { createLogger } from '@vina/shared';
import { takeSnapshot, type UiNode, type UiRef, type UiTree } from '../snapshot/snapshot.js';
import { findByLabel, resolveRef } from '../snapshot/refs.js';
import type { ActAction, ApplicationSession } from './adapter.js';

const log = createLogger('automation.session-actions');

/**
 * Roles accepted by Playwright's `getByRole`. CDP exposes a superset
 * (e.g. 'StaticText', 'LabelText') that isn't actionable; this list keeps
 * `act` to roles we can dispatch against.
 */
const ACTIONABLE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'menuitem',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
]);

/**
 * Take a fresh accessibility snapshot of the session's page and store it
 * on the session for subsequent `act` calls to read.
 */
export async function snapshotSession(session: ApplicationSession): Promise<UiTree> {
  const tree = await takeSnapshot(session.page);
  session.latestSnapshot = tree;
  return tree;
}

type AriaRole = Parameters<Page['getByRole']>[0];

function validateAction(role: string, action: ActAction, value: string | undefined): void {
  if (!ACTIONABLE_ROLES.has(role)) {
    throw new Error(`act: role '${role}' is not actionable`);
  }
  if (action === 'select' && value === undefined) {
    throw new Error("act('select') requires a value");
  }
}

async function dispatchAction(
  page: Page,
  role: string,
  name: string,
  action: ActAction,
  value: string | undefined,
): Promise<void> {
  // Cast: ACTIONABLE_ROLES is a curated subset of valid AriaRole literals.
  const locator = page.getByRole(role as AriaRole, { name, exact: true }).first();
  switch (action) {
    case 'click':
      await locator.click();
      return;
    case 'check':
      await locator.check();
      return;
    case 'select':
      // validateAction has already enforced value !== undefined.
      await locator.selectOption(value!);
      return;
  }
}

/**
 * Resolve `ref` in the session's latest snapshot, then dispatch `action`.
 * On dispatch failure (element gone, click intercepted, etc.) re-snapshot
 * once and re-resolve the original (role, name) before giving up — this is
 * the stale-ref retry from ADR-022.
 */
export async function actOnSession(
  session: ApplicationSession,
  ref: UiRef,
  action: ActAction,
  value?: string,
): Promise<void> {
  const cached = session.latestSnapshot;
  if (!cached) {
    throw new Error('actOnSession: call snapshot() before act()');
  }
  const cachedNode: UiNode | null = resolveRef(cached, ref);
  if (!cachedNode) {
    throw new Error(`actOnSession: ref ${ref} not present in latest snapshot`);
  }

  // Structural guards throw unconditionally — never retried.
  validateAction(cachedNode.role, action, value);

  try {
    await dispatchAction(session.page, cachedNode.role, cachedNode.name, action, value);
    return;
  } catch (err) {
    log.warn(
      { err, ref, role: cachedNode.role, name: cachedNode.name },
      'act dispatch failed; re-snapshotting for label-based retry',
    );
  }

  const fresh = await takeSnapshot(session.page);
  const retry = findByLabel(fresh, cachedNode.role, cachedNode.name);
  if (!retry) {
    throw new Error(
      `actOnSession: cannot resolve ${cachedNode.role}/'${cachedNode.name}' after re-snapshot`,
    );
  }
  await dispatchAction(session.page, retry.role, retry.name, action, value);
  session.latestSnapshot = fresh;
}
