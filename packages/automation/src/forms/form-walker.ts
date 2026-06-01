import { walkTree } from '../snapshot/refs.js';
import type { UiNode, UiTree } from '../snapshot/snapshot.js';
import { matchCanonicalKey } from './field-map.js';
import type { FormField, FormFieldKind } from './types.js';

const TEXT_ROLES = new Set(['textbox', 'searchbox']);

function classifyRole(node: UiNode): FormFieldKind | null {
  if (TEXT_ROLES.has(node.role)) return 'text';
  if (node.role === 'combobox' || node.role === 'listbox') return 'select';
  if (node.role === 'checkbox') return 'checkbox';
  if (node.role === 'spinbutton') return 'number';
  if (node.role === 'slider') return 'number';
  if (node.role === 'radiogroup') return 'radio';
  // Standalone `radio` and other roles are intentionally skipped — a radio
  // outside a radiogroup is unusual and the form walker treats the group
  // as the field.
  return null;
}

/**
 * Refine a `text` kind to `email`/`phone`/`url` when the canonical key
 * implies a more specific input. The accessibility role alone can't
 * disambiguate — HTML5 `type=email` / `type=tel` / `type=url` all surface
 * as `textbox` in the a11y tree.
 */
function refineTextKind(
  kind: FormFieldKind,
  canonical: string | undefined,
): FormFieldKind {
  if (kind !== 'text' || !canonical) return kind;
  if (canonical === 'email') return 'email';
  if (canonical === 'phone') return 'phone';
  if (
    canonical === 'website_url' ||
    canonical === 'linkedin_url' ||
    canonical === 'github_url'
  ) {
    return 'url';
  }
  return kind;
}

/**
 * Walk a UI snapshot and emit a deterministic list of `FormField`s. No
 * Playwright dependency — pure function over a `UiTree` (ADR-022). The
 * caller (form-walker integration in M15) drives the snapshot/act loop;
 * the LLM fallback only fires when this walker can't classify a field.
 */
export function walkForm(tree: UiTree): FormField[] {
  const fields: FormField[] = [];
  walkTree(tree, (node) => {
    const baseKind = classifyRole(node);
    if (!baseKind) return;

    const canonical = matchCanonicalKey(node.name);
    const kind = refineTextKind(baseKind, canonical);

    const field: FormField = {
      ref: node.ref,
      label: node.name,
      kind,
      required: node.required ?? false,
    };
    if (node.value !== undefined) field.value = node.value;
    if (node.disabled !== undefined) field.disabled = node.disabled;

    if (baseKind === 'radio' && node.children) {
      const radioOptions = node.children
        .filter((c) => c.role === 'radio' && c.name.length > 0)
        .map((c) => c.name);
      if (radioOptions.length > 0) field.options = radioOptions;
    } else if (node.options && node.options.length > 0) {
      field.options = [...node.options];
    }

    if (canonical) field.canonicalKey = canonical;
    fields.push(field);
  });
  return fields;
}
