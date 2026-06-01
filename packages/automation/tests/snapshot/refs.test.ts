import { describe, expect, it } from 'vitest';
import {
  accessibilityNodeToUiTree,
  type RawAccessibilityNode,
} from '../../src/snapshot/snapshot.js';
import { findByLabel, resolveRef, walkTree } from '../../src/snapshot/refs.js';

const fixture: RawAccessibilityNode = {
  role: 'WebArea',
  name: 'Apply',
  children: [
    { role: 'textbox', name: 'First name' },
    { role: 'textbox', name: 'Email' },
    {
      role: 'group',
      name: 'Address',
      children: [
        { role: 'textbox', name: 'Street' },
        { role: 'textbox', name: 'City' },
      ],
    },
    { role: 'button', name: 'Submit' },
  ],
};

describe('resolveRef', () => {
  it('returns the node when the ref exists in the snapshot', () => {
    const tree = accessibilityNodeToUiTree(fixture);
    // r0=WebArea, r1=First name, r2=Email, r3=Address, r4=Street, r5=City, r6=Submit
    const node = resolveRef(tree, 'r1');
    expect(node?.name).toBe('First name');
    expect(node?.role).toBe('textbox');
  });

  it('returns null when the ref does not exist (stale)', () => {
    const tree = accessibilityNodeToUiTree(fixture);
    expect(resolveRef(tree, 'r999')).toBeNull();
  });

  it('finds deeply nested refs', () => {
    const tree = accessibilityNodeToUiTree(fixture);
    const street = resolveRef(tree, 'r4');
    expect(street?.name).toBe('Street');
  });
});

describe('findByLabel', () => {
  it('returns the first node matching role and accessible name', () => {
    const tree = accessibilityNodeToUiTree(fixture);
    const node = findByLabel(tree, 'textbox', 'Email');
    expect(node?.name).toBe('Email');
    expect(node?.ref).toBe('r2');
  });

  it('returns null when no node matches', () => {
    const tree = accessibilityNodeToUiTree(fixture);
    expect(findByLabel(tree, 'textbox', 'Phone')).toBeNull();
  });

  it('uses both role and name (a button labelled "Email" does not match a textbox)', () => {
    const tree = accessibilityNodeToUiTree(fixture);
    expect(findByLabel(tree, 'button', 'Email')).toBeNull();
  });

  it('matches across nested groups', () => {
    const tree = accessibilityNodeToUiTree(fixture);
    const city = findByLabel(tree, 'textbox', 'City');
    expect(city?.name).toBe('City');
  });
});

describe('walkTree', () => {
  it('visits every node depth-first', () => {
    const tree = accessibilityNodeToUiTree(fixture);
    const visited: string[] = [];
    walkTree(tree, (n) => visited.push(n.name));
    expect(visited).toEqual([
      'Apply',
      'First name',
      'Email',
      'Address',
      'Street',
      'City',
      'Submit',
    ]);
  });
});
