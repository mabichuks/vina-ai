import { describe, expect, it } from 'vitest';
import { axNodesToTree, type AXNode } from '../../src/snapshot/snapshot.js';

function node(
  id: string,
  role: string,
  name: string,
  opts: {
    children?: string[];
    ignored?: boolean;
    value?: string | number;
    required?: boolean;
    disabled?: boolean;
  } = {},
): AXNode {
  const properties: AXNode['properties'] = [];
  if (opts.required !== undefined)
    properties.push({ name: 'required', value: { type: 'boolean', value: opts.required } });
  if (opts.disabled !== undefined)
    properties.push({ name: 'disabled', value: { type: 'boolean', value: opts.disabled } });

  const ax: AXNode = {
    nodeId: id,
    ignored: opts.ignored ?? false,
    role: { type: 'role', value: role },
    name: { type: 'computedString', value: name },
  };
  if (opts.value !== undefined) ax.value = { type: 'string', value: opts.value };
  if (properties.length > 0) ax.properties = properties;
  if (opts.children && opts.children.length > 0) ax.childIds = opts.children;
  return ax;
}

describe('axNodesToTree', () => {
  it('returns null for an empty list', () => {
    expect(axNodesToTree([])).toBeNull();
  });

  it('reshapes a flat CDP node list into a tree under the root', () => {
    const nodes: AXNode[] = [
      node('1', 'RootWebArea', 'Apply', { children: ['2', '3'] }),
      node('2', 'textbox', 'First name', { required: true }),
      node('3', 'button', 'Submit'),
    ];
    const raw = axNodesToTree(nodes);
    expect(raw).not.toBeNull();
    expect(raw!.role).toBe('RootWebArea');
    expect(raw!.name).toBe('Apply');
    expect(raw!.children).toHaveLength(2);
    expect(raw!.children![0]!.role).toBe('textbox');
    expect(raw!.children![0]!.required).toBe(true);
    expect(raw!.children![1]!.role).toBe('button');
  });

  it('flattens ignored nodes by hoisting their visible children', () => {
    const nodes: AXNode[] = [
      node('1', 'RootWebArea', '', { children: ['2'] }),
      node('2', 'generic', '', { ignored: true, children: ['3', '4'] }),
      node('3', 'textbox', 'Email'),
      node('4', 'button', 'Submit'),
    ];
    const raw = axNodesToTree(nodes);
    expect(raw!.children).toHaveLength(2);
    expect(raw!.children![0]!.role).toBe('textbox');
    expect(raw!.children![1]!.role).toBe('button');
  });

  it('flattens chains of ignored nodes recursively', () => {
    const nodes: AXNode[] = [
      node('1', 'RootWebArea', '', { children: ['2'] }),
      node('2', 'generic', '', { ignored: true, children: ['3'] }),
      node('3', 'generic', '', { ignored: true, children: ['4'] }),
      node('4', 'textbox', 'Phone'),
    ];
    const raw = axNodesToTree(nodes);
    expect(raw!.children).toHaveLength(1);
    expect(raw!.children![0]!.role).toBe('textbox');
    expect(raw!.children![0]!.name).toBe('Phone');
  });

  it('coerces numeric AXValue values to strings', () => {
    const nodes: AXNode[] = [
      node('1', 'slider', 'Volume', { value: 75 }),
    ];
    const raw = axNodesToTree(nodes);
    expect(raw!.value).toBe('75');
  });

  it('propagates disabled property', () => {
    const nodes: AXNode[] = [
      node('1', 'button', 'Apply', { disabled: true }),
    ];
    const raw = axNodesToTree(nodes);
    expect(raw!.disabled).toBe(true);
  });

  it('omits missing properties (does not emit value/required/disabled when absent)', () => {
    const nodes: AXNode[] = [
      node('1', 'textbox', 'Name'),
    ];
    const raw = axNodesToTree(nodes);
    expect(raw).toEqual({ role: 'textbox', name: 'Name' });
  });
});
