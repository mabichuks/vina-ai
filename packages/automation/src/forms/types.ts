import type { UiRef } from '../snapshot/snapshot.js';

/**
 * Field shapes recognised by the deterministic form walker. The walker
 * classifies by accessibility role first (textbox/combobox/checkbox/...)
 * and refines `text` to `email`/`phone`/`url` when the label matches a
 * canonical key. `multiselect` is reserved for future use.
 */
export type FormFieldKind =
  | 'text'
  | 'textarea'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'file'
  | 'date'
  | 'phone'
  | 'url'
  | 'email'
  | 'number'
  | 'multiselect';

/**
 * A single discovered form field. `ref` is the primary handle for ADR-022
 * snapshot/act; `selector` is reserved for adapter-specific fallbacks on
 * widgets whose accessibility tree is poor (custom dropdowns, some radio
 * groups). The walker itself only emits `ref` — adapters can layer
 * selectors on top.
 */
export interface FormField {
  ref: UiRef;
  selector?: string;
  label: string;
  kind: FormFieldKind;
  required: boolean;
  /** Option labels for `select` / `radio` / `multiselect`. */
  options?: string[];
  /** Currently-presented value (e.g. a select's chosen option). */
  value?: string;
  disabled?: boolean;
  /** Match from `field-map.ts` — undefined when the label doesn't map. */
  canonicalKey?: string;
}
