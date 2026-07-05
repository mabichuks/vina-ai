import { describe, expect, it } from 'vitest';
import { walkForm } from '../../src/forms/form-walker.js';
import {
  accessibilityNodeToUiTree,
  type RawAccessibilityNode,
} from '../../src/snapshot/snapshot.js';

function tree(raw: RawAccessibilityNode) {
  return accessibilityNodeToUiTree(raw);
}

describe('walkForm — classification by role', () => {
  it('emits a `text` field for textbox', () => {
    const fields = walkForm(
      tree({
        role: 'RootWebArea',
        name: '',
        children: [{ role: 'textbox', name: 'Notes' }],
      }),
    );
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      label: 'Notes',
      kind: 'text',
      required: false,
    });
  });

  it('emits a `checkbox` field for checkbox', () => {
    const fields = walkForm(
      tree({
        role: 'RootWebArea',
        name: '',
        children: [{ role: 'checkbox', name: 'Subscribe' }],
      }),
    );
    expect(fields[0]?.kind).toBe('checkbox');
  });

  it('emits a `select` field for combobox with options', () => {
    const fields = walkForm(
      tree({
        role: 'RootWebArea',
        name: '',
        children: [
          {
            role: 'combobox',
            name: 'Country',
            value: 'United Kingdom',
            children: [
              { role: 'option', name: 'United Kingdom' },
              { role: 'option', name: 'France' },
            ],
          },
        ],
      }),
    );
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      kind: 'select',
      label: 'Country',
      value: 'United Kingdom',
      options: ['United Kingdom', 'France'],
      canonicalKey: 'location_country',
    });
  });

  it('emits a `radio` field for radiogroup, listing child radios as options', () => {
    const fields = walkForm(
      tree({
        role: 'RootWebArea',
        name: '',
        children: [
          {
            role: 'radiogroup',
            name: 'Right to work',
            children: [
              { role: 'radio', name: 'Yes' },
              { role: 'radio', name: 'No' },
            ],
          },
        ],
      }),
    );
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      kind: 'radio',
      label: 'Right to work',
      options: ['Yes', 'No'],
    });
  });

  it('emits a `number` field for spinbutton', () => {
    const fields = walkForm(
      tree({
        role: 'RootWebArea',
        name: '',
        children: [{ role: 'spinbutton', name: 'Years of experience' }],
      }),
    );
    expect(fields[0]).toMatchObject({
      kind: 'number',
      canonicalKey: 'years_experience',
    });
  });

  it('skips non-interactive roles (StaticText, button, generic)', () => {
    const fields = walkForm(
      tree({
        role: 'RootWebArea',
        name: '',
        children: [
          { role: 'StaticText', name: 'Heading' },
          { role: 'button', name: 'Submit' },
          {
            role: 'generic',
            name: '',
            children: [{ role: 'textbox', name: 'Hidden in generic' }],
          },
        ],
      }),
    );
    // Only the textbox nested under the generic survives.
    expect(fields).toHaveLength(1);
    expect(fields[0]?.label).toBe('Hidden in generic');
  });
});

describe('walkForm — kind refinement via canonical key', () => {
  it('refines textbox to `email` when label maps to canonical email', () => {
    const fields = walkForm(
      tree({
        role: 'RootWebArea',
        name: '',
        children: [{ role: 'textbox', name: 'Email address', required: true }],
      }),
    );
    expect(fields[0]).toMatchObject({
      kind: 'email',
      required: true,
      canonicalKey: 'email',
    });
  });

  it('refines textbox to `phone` for phone labels', () => {
    const fields = walkForm(
      tree({
        role: 'RootWebArea',
        name: '',
        children: [{ role: 'textbox', name: 'Mobile number' }],
      }),
    );
    expect(fields[0]?.kind).toBe('phone');
    expect(fields[0]?.canonicalKey).toBe('phone');
  });

  it('refines textbox to `url` for LinkedIn / GitHub / portfolio labels', () => {
    const fields = walkForm(
      tree({
        role: 'RootWebArea',
        name: '',
        children: [
          { role: 'textbox', name: 'LinkedIn URL' },
          { role: 'textbox', name: 'GitHub profile' },
          { role: 'textbox', name: 'Personal site' },
        ],
      }),
    );
    expect(fields.map((f) => f.kind)).toEqual(['url', 'url', 'url']);
    expect(fields.map((f) => f.canonicalKey)).toEqual([
      'linkedin_url',
      'github_url',
      'website_url',
    ]);
  });

  it('leaves kind as `text` when no canonical key matches', () => {
    const fields = walkForm(
      tree({
        role: 'RootWebArea',
        name: '',
        children: [{ role: 'textbox', name: 'Salary expectation' }],
      }),
    );
    expect(fields[0]?.kind).toBe('text');
    expect(fields[0]?.canonicalKey).toBeUndefined();
  });
});

describe('walkForm — attribute propagation', () => {
  it('propagates required, value, disabled', () => {
    const fields = walkForm(
      tree({
        role: 'RootWebArea',
        name: '',
        children: [
          {
            role: 'textbox',
            name: 'First name',
            value: 'Ada',
            required: true,
            disabled: false,
          },
        ],
      }),
    );
    expect(fields[0]).toMatchObject({
      ref: expect.stringMatching(/^r\d+$/),
      label: 'First name',
      kind: 'text',
      required: true,
      value: 'Ada',
      disabled: false,
      canonicalKey: 'first_name',
    });
  });

  it('omits value/disabled when absent', () => {
    const fields = walkForm(
      tree({
        role: 'RootWebArea',
        name: '',
        children: [{ role: 'textbox', name: 'Email' }],
      }),
    );
    expect(fields[0]?.value).toBeUndefined();
    expect(fields[0]?.disabled).toBeUndefined();
  });
});
