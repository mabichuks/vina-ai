import type { Page } from 'playwright';

/** A stable handle for a node within a single snapshot (ADR-022). */
export type UiRef = string;

/**
 * Normalised accessibility node. Mirrors Playwright's `AccessibilityNode`
 * but with a ref injected and value/options coerced to strings.
 *
 * Refs are valid only within the snapshot that produced them; any UI change
 * (step advance, dynamic field reveal) invalidates them. Re-snapshot before
 * acting again. See ADR-022.
 */
export interface UiNode {
  ref: UiRef;
  role: string;
  name: string;
  value?: string;
  required?: boolean;
  disabled?: boolean;
  /** Populated when this node's immediate children include role='option' or 'menuitem'. */
  options?: string[];
  children?: UiNode[];
}

export interface UiTree {
  takenAt: number;
  root: UiNode;
}

/**
 * Raw Playwright accessibility node shape. Re-declared here (rather than
 * imported) because Playwright doesn't export the type as a named symbol.
 * Only the fields we care about are listed.
 */
export interface RawAccessibilityNode {
  role: string;
  name?: string;
  value?: string | number;
  required?: boolean;
  disabled?: boolean;
  children?: RawAccessibilityNode[];
}

const OPTION_ROLES = new Set(['option', 'menuitem']);

function rawToUi(raw: RawAccessibilityNode, allocate: () => UiRef): UiNode {
  // Trim accessible names per the W3C accname spec — Chrome leaves trailing
  // whitespace from inline label text content, which would otherwise force
  // every consumer to remember to trim before comparing.
  const node: UiNode = {
    ref: allocate(),
    role: raw.role,
    name: (raw.name ?? '').trim(),
  };
  if (raw.value !== undefined) node.value = String(raw.value);
  if (raw.required !== undefined) node.required = raw.required;
  if (raw.disabled !== undefined) node.disabled = raw.disabled;

  if (raw.children && raw.children.length > 0) {
    const children = raw.children.map((c) => rawToUi(c, allocate));
    node.children = children;
    const optionNames = children
      .filter((c) => OPTION_ROLES.has(c.role) && c.name)
      .map((c) => c.name);
    if (optionNames.length > 0) {
      node.options = optionNames;
    }
  }

  return node;
}

/** Convert a raw Playwright a11y tree to a ref-keyed UiTree. Depth-first refs. */
export function accessibilityNodeToUiTree(raw: RawAccessibilityNode | null): UiTree {
  let counter = 0;
  const allocate = (): UiRef => `r${counter++}`;
  const root = raw
    ? rawToUi(raw, allocate)
    : { ref: allocate(), role: 'WebArea', name: '' };
  return { takenAt: Date.now(), root };
}

/**
 * Subset of the Chrome DevTools Protocol Accessibility node shape — the bits
 * we extract. `Accessibility.getFullAXTree` returns a flat list; we
 * reconstruct the parent/child shape by walking `childIds`.
 */
interface AXValue {
  type: string;
  value?: unknown;
}

interface AXProperty {
  name: string;
  value: AXValue;
}

export interface AXNode {
  nodeId: string;
  parentId?: string;
  childIds?: string[];
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: AXProperty[];
}

function axString(v: AXValue | undefined): string {
  if (!v) return '';
  if (typeof v.value === 'string') return v.value;
  if (typeof v.value === 'number') return String(v.value);
  return '';
}

function axBoolProperty(node: AXNode, name: string): boolean | undefined {
  const p = node.properties?.find((pp) => pp.name === name);
  if (!p) return undefined;
  if (typeof p.value.value === 'boolean') return p.value.value;
  return undefined;
}

/**
 * Reshape a flat CDP AX node list into a tree of `RawAccessibilityNode`.
 * Ignored nodes are skipped but their non-ignored descendants are hoisted
 * into the nearest visible ancestor — keeps the resulting tree free of
 * ARIA-invisible noise without losing structure.
 */
export function axNodesToTree(nodes: readonly AXNode[]): RawAccessibilityNode | null {
  if (nodes.length === 0) return null;
  const byId = new Map<string, AXNode>(nodes.map((n) => [n.nodeId, n]));

  const referencedAsChild = new Set<string>();
  for (const n of nodes) {
    for (const c of n.childIds ?? []) referencedAsChild.add(c);
  }
  let root: AXNode | undefined;
  for (const n of nodes) {
    if (!referencedAsChild.has(n.nodeId)) {
      root = n;
      break;
    }
  }
  if (!root) return null;

  function collectVisible(n: AXNode): AXNode[] {
    const out: AXNode[] = [];
    for (const cid of n.childIds ?? []) {
      const c = byId.get(cid);
      if (!c) continue;
      if (c.ignored) out.push(...collectVisible(c));
      else out.push(c);
    }
    return out;
  }

  function build(n: AXNode): RawAccessibilityNode {
    const children = collectVisible(n).map(build);
    const raw: RawAccessibilityNode = {
      role: axString(n.role),
      name: axString(n.name),
    };
    const value = axString(n.value);
    if (value) raw.value = value;
    const required = axBoolProperty(n, 'required');
    if (required !== undefined) raw.required = required;
    const disabled = axBoolProperty(n, 'disabled');
    if (disabled !== undefined) raw.disabled = disabled;
    if (children.length > 0) raw.children = children;
    return raw;
  }

  if (root.ignored) {
    const visible = collectVisible(root);
    if (visible.length === 0) return null;
    if (visible.length === 1) return build(visible[0]!);
    return { role: 'WebArea', name: '', children: visible.map(build) };
  }
  return build(root);
}

/**
 * Capture an accessibility snapshot of the current page and inject stable
 * refs (ADR-022). Uses Chrome DevTools Protocol `Accessibility.getFullAXTree`
 * — `page.accessibility.snapshot()` was removed in Playwright 1.59. Refs
 * are valid only within the returned tree.
 */
export async function takeSnapshot(page: Page): Promise<UiTree> {
  const session = await page.context().newCDPSession(page);
  try {
    const result = (await session.send('Accessibility.getFullAXTree')) as {
      nodes: AXNode[];
    };
    const raw = axNodesToTree(result.nodes);
    return accessibilityNodeToUiTree(raw);
  } finally {
    await session.detach().catch(() => undefined);
  }
}
