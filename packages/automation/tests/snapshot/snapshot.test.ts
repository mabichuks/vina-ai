import { describe, expect, it } from 'vitest';
import {
  accessibilityNodeToUiTree,
  type RawAccessibilityNode,
} from '../../src/snapshot/snapshot.js';
import { walkTree } from '../../src/snapshot/refs.js';

const sampleTree: RawAccessibilityNode = {
  role: 'WebArea',
  name: 'Application',
  children: [
    { role: 'textbox', name: 'First name', required: true, value: 'Ada' },
    { role: 'textbox', name: 'Email', required: true },
    {
      role: 'combobox',
      name: 'Country',
      children: [
        { role: 'option', name: 'United Kingdom' },
        { role: 'option', name: 'France' },
        { role: 'option', name: 'Germany' },
      ],
    },
    { role: 'button', name: 'Submit' },
  ],
};

describe('accessibilityNodeToUiTree', () => {
  it('returns a tree with depth-first refs', () => {
    const tree = accessibilityNodeToUiTree(sampleTree);
    const refs: string[] = [];
    walkTree(tree, (n) => refs.push(n.ref));
    // depth-first: WebArea, textbox×2, combobox, option×3, button → 8 nodes
    expect(refs).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']);
  });

  it('refs are unique within a single snapshot', () => {
    const tree = accessibilityNodeToUiTree(sampleTree);
    const seen = new Set<string>();
    walkTree(tree, (n) => seen.add(n.ref));
    let total = 0;
    walkTree(tree, () => total++);
    expect(seen.size).toBe(total);
  });

  it('propagates value/required/disabled', () => {
    const tree = accessibilityNodeToUiTree(sampleTree);
    const first = tree.root.children?.[0];
    expect(first?.value).toBe('Ada');
    expect(first?.required).toBe(true);
    expect(first?.disabled).toBeUndefined();
  });

  it('coerces numeric value to string', () => {
    const tree = accessibilityNodeToUiTree({
      role: 'WebArea',
      name: '',
      children: [{ role: 'slider', name: 'Volume', value: 42 }],
    });
    expect(tree.root.children?.[0]?.value).toBe('42');
  });

  it('extracts options for nodes whose children include role=option', () => {
    const tree = accessibilityNodeToUiTree(sampleTree);
    const combobox = tree.root.children?.[2];
    expect(combobox?.options).toEqual(['United Kingdom', 'France', 'Germany']);
  });

  it('leaves options undefined when children are not options', () => {
    const tree = accessibilityNodeToUiTree(sampleTree);
    const button = tree.root.children?.[3];
    expect(button?.options).toBeUndefined();
  });

  it('handles a null raw root by returning an empty WebArea root', () => {
    const tree = accessibilityNodeToUiTree(null);
    expect(tree.root.role).toBe('WebArea');
    expect(tree.root.name).toBe('');
    expect(tree.root.ref).toBe('r0');
  });

  it('stamps takenAt with a positive timestamp', () => {
    const before = Date.now();
    const tree = accessibilityNodeToUiTree(sampleTree);
    const after = Date.now();
    expect(tree.takenAt).toBeGreaterThanOrEqual(before);
    expect(tree.takenAt).toBeLessThanOrEqual(after);
  });

  it('produces fresh refs on each call (snapshots are independent)', () => {
    const a = accessibilityNodeToUiTree(sampleTree);
    const b = accessibilityNodeToUiTree(sampleTree);
    // Same counter range in each, refs are independent identities scoped to a tree.
    const refsA: string[] = [];
    const refsB: string[] = [];
    walkTree(a, (n) => refsA.push(n.ref));
    walkTree(b, (n) => refsB.push(n.ref));
    expect(refsA).toEqual(refsB);
  });
});
