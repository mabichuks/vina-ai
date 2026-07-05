import { describe, expect, it, vi } from 'vitest';
import {
  actOnSession,
  snapshotSession,
} from '../../src/adapters/session-actions.js';
import type { ApplicationSession } from '../../src/adapters/adapter.js';
import type { Page } from 'playwright';
import type { UiTree } from '../../src/snapshot/snapshot.js';

/** Build a minimal fake Page that captures interactions. */
function fakePage(opts: {
  cdpAxNodes?: unknown[];
  onClick?: () => void | Promise<void>;
  onCheck?: () => void | Promise<void>;
  onSelect?: (value: string | string[]) => void | Promise<void>;
  throwOnFirstAction?: boolean;
} = {}): Page {
  let actionAttempt = 0;
  const locator = {
    first() {
      return this;
    },
    async click() {
      actionAttempt++;
      if (opts.throwOnFirstAction && actionAttempt === 1) {
        throw new Error('intercepted');
      }
      await opts.onClick?.();
    },
    async check() {
      actionAttempt++;
      if (opts.throwOnFirstAction && actionAttempt === 1) {
        throw new Error('intercepted');
      }
      await opts.onCheck?.();
    },
    async selectOption(value: string | string[]) {
      actionAttempt++;
      if (opts.throwOnFirstAction && actionAttempt === 1) {
        throw new Error('intercepted');
      }
      await opts.onSelect?.(value);
    },
  };
  const session = {
    async newCDPSession() {
      return {
        async send() {
          return { nodes: opts.cdpAxNodes ?? [] };
        },
        async detach() {
          return undefined;
        },
      };
    },
  };
  const page = {
    context() {
      return session;
    },
    getByRole(_role: string, _opts: unknown) {
      return locator;
    },
  };
  return page as unknown as Page;
}

function makeSession(page: Page, latestSnapshot?: UiTree): ApplicationSession {
  return latestSnapshot
    ? { page, formId: 'test-form', latestSnapshot }
    : { page, formId: 'test-form' };
}

describe('snapshotSession', () => {
  it('takes a fresh snapshot and stores it on the session', async () => {
    const page = fakePage({
      cdpAxNodes: [
        {
          nodeId: '1',
          ignored: false,
          role: { type: 'role', value: 'RootWebArea' },
          name: { type: 'computedString', value: 'Form' },
          childIds: ['2'],
        },
        {
          nodeId: '2',
          ignored: false,
          role: { type: 'role', value: 'textbox' },
          name: { type: 'computedString', value: 'Email' },
        },
      ],
    });
    const session = makeSession(page);
    expect(session.latestSnapshot).toBeUndefined();

    const tree = await snapshotSession(session);
    expect(tree).toBe(session.latestSnapshot);
    expect(tree.root.role).toBe('RootWebArea');
    expect(tree.root.children?.[0]?.role).toBe('textbox');
    expect(tree.root.children?.[0]?.name).toBe('Email');
  });
});

describe('actOnSession', () => {
  const treeWithButton: UiTree = {
    takenAt: 1,
    root: {
      ref: 'r0',
      role: 'RootWebArea',
      name: 'Form',
      children: [{ ref: 'r1', role: 'button', name: 'Submit' }],
    },
  };

  it('throws when called before snapshot()', async () => {
    const page = fakePage();
    const session = makeSession(page);
    await expect(actOnSession(session, 'r1', 'click')).rejects.toThrow(
      /call snapshot/i,
    );
  });

  it('throws when the ref is not in the cached snapshot', async () => {
    const page = fakePage();
    const session = makeSession(page, treeWithButton);
    await expect(actOnSession(session, 'r99', 'click')).rejects.toThrow(
      /not present in latest snapshot/,
    );
  });

  it('dispatches click via getByRole(role, { name })', async () => {
    let clicked = false;
    const page = fakePage({ onClick: () => { clicked = true; } });
    const getByRoleSpy = vi.spyOn(page, 'getByRole');
    const session = makeSession(page, treeWithButton);

    await actOnSession(session, 'r1', 'click');

    expect(clicked).toBe(true);
    expect(getByRoleSpy).toHaveBeenCalledWith('button', { name: 'Submit', exact: true });
  });

  it('dispatches check on checkbox refs', async () => {
    const tree: UiTree = {
      takenAt: 1,
      root: {
        ref: 'r0',
        role: 'RootWebArea',
        name: 'Form',
        children: [{ ref: 'r1', role: 'checkbox', name: 'Agree to terms' }],
      },
    };
    let checked = false;
    const page = fakePage({ onCheck: () => { checked = true; } });
    const session = makeSession(page, tree);

    await actOnSession(session, 'r1', 'check');
    expect(checked).toBe(true);
  });

  it('select requires a value', async () => {
    const tree: UiTree = {
      takenAt: 1,
      root: {
        ref: 'r0',
        role: 'RootWebArea',
        name: 'Form',
        children: [{ ref: 'r1', role: 'combobox', name: 'Country' }],
      },
    };
    const page = fakePage();
    const session = makeSession(page, tree);

    await expect(actOnSession(session, 'r1', 'select')).rejects.toThrow(/requires a value/);
  });

  it('select passes the value through to selectOption', async () => {
    const tree: UiTree = {
      takenAt: 1,
      root: {
        ref: 'r0',
        role: 'RootWebArea',
        name: 'Form',
        children: [{ ref: 'r1', role: 'combobox', name: 'Country' }],
      },
    };
    let selected: string | string[] | null = null;
    const page = fakePage({ onSelect: (v) => { selected = v; } });
    const session = makeSession(page, tree);

    await actOnSession(session, 'r1', 'select', 'France');
    expect(selected).toBe('France');
  });

  it('refuses to act on non-actionable roles (e.g. StaticText)', async () => {
    const tree: UiTree = {
      takenAt: 1,
      root: {
        ref: 'r0',
        role: 'RootWebArea',
        name: 'Form',
        children: [{ ref: 'r1', role: 'StaticText', name: 'Hello' }],
      },
    };
    const page = fakePage();
    const session = makeSession(page, tree);
    await expect(actOnSession(session, 'r1', 'click')).rejects.toThrow(
      /not actionable/,
    );
  });

  it('retries once via label-based re-resolution when the first dispatch throws', async () => {
    let clicked = false;
    const page = fakePage({
      throwOnFirstAction: true,
      onClick: () => { clicked = true; },
      // CDP returns the same node so findByLabel can re-resolve "Submit" button.
      cdpAxNodes: [
        {
          nodeId: '1',
          ignored: false,
          role: { type: 'role', value: 'RootWebArea' },
          name: { type: 'computedString', value: 'Form' },
          childIds: ['2'],
        },
        {
          nodeId: '2',
          ignored: false,
          role: { type: 'role', value: 'button' },
          name: { type: 'computedString', value: 'Submit' },
        },
      ],
    });
    const session = makeSession(page, treeWithButton);
    await actOnSession(session, 'r1', 'click');
    expect(clicked).toBe(true);
    // The retry triggered a fresh snapshot — the session now holds the new tree.
    expect(session.latestSnapshot?.root.children?.[0]?.role).toBe('button');
  });

  it('throws if the post-retry snapshot also lacks the (role, name)', async () => {
    const page = fakePage({
      throwOnFirstAction: true,
      // Fresh snapshot has no button — the form moved on.
      cdpAxNodes: [
        {
          nodeId: '1',
          ignored: false,
          role: { type: 'role', value: 'RootWebArea' },
          name: { type: 'computedString', value: 'Confirmation' },
        },
      ],
    });
    const session = makeSession(page, treeWithButton);
    await expect(actOnSession(session, 'r1', 'click')).rejects.toThrow(
      /cannot resolve button/,
    );
  });
});
