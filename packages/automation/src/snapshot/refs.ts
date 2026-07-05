import type { UiNode, UiRef, UiTree } from './snapshot.js';

/** Walk a tree depth-first. */
export function walkTree(tree: UiTree, visit: (node: UiNode) => void): void {
  walkNode(tree.root, visit);
}

function walkNode(node: UiNode, visit: (node: UiNode) => void): void {
  visit(node);
  if (node.children) {
    for (const child of node.children) walkNode(child, visit);
  }
}

/** Resolve a ref within a snapshot. Returns null if absent (snapshot is stale). */
export function resolveRef(tree: UiTree, ref: UiRef): UiNode | null {
  let found: UiNode | null = null;
  walkTree(tree, (node) => {
    if (found) return;
    if (node.ref === ref) found = node;
  });
  return found;
}

/**
 * Re-resolve a stale ref in a fresh snapshot by matching the original node's
 * (role, name). Returns the first match — accessible names should be unique
 * within a form, and the deterministic walker only calls this after a single
 * stale-ref event. Returns null when nothing matches.
 */
export function findByLabel(
  tree: UiTree,
  role: string,
  name: string,
): UiNode | null {
  let found: UiNode | null = null;
  walkTree(tree, (node) => {
    if (found) return;
    if (node.role === role && node.name === name) found = node;
  });
  return found;
}
