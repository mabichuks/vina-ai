import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadSkill, parseSkill } from '../../src/skills/loader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_APPLY_PATH = path.resolve(
  HERE,
  '..',
  '..',
  'skills',
  'browser-apply',
  'SKILL.md',
);

describe('loadSkill — real browser-apply SKILL.md', () => {
  it('parses the ADR-022 browser-apply skill', async () => {
    const skill = await loadSkill(BROWSER_APPLY_PATH);
    expect(skill.meta.id).toBe('browser-apply');
    expect(skill.meta.name).toBe('browser-apply');
    expect(skill.meta.description).toMatch(/snapshot the form/i);
    expect(skill.meta.applies_to).toEqual(['apply']);
    expect(skill.meta.capabilities).toContain('snapshot');
    expect(skill.meta.capabilities).toContain('createAlert');
    expect(skill.meta.editable_by_user).toBe(false);
    expect(skill.meta.version).toBe(2);
    expect(skill.body).toMatch(/Interaction model/i);
    expect(skill.body).toMatch(/Stale-ref recovery/i);
  });
});

describe('parseSkill — frontmatter shapes', () => {
  it('parses scalar string, inline array, boolean, integer', () => {
    const skill = parseSkill(
      `---\nid: foo\nname: foo\ndescription: A skill\napplies_to: [apply, search]\ncapabilities: [a, b, c]\neditable_by_user: true\nversion: 3\n---\nBody here.\n`,
    );
    expect(skill.meta).toEqual({
      id: 'foo',
      name: 'foo',
      description: 'A skill',
      applies_to: ['apply', 'search'],
      capabilities: ['a', 'b', 'c'],
      editable_by_user: true,
      version: 3,
    });
    expect(skill.body).toBe('Body here.');
  });

  it('folds multi-line `description: >` into a single string', () => {
    const skill = parseSkill(
      `---\nid: foo\nname: foo\ndescription: >\n  line one\n  line two\n  line three\n---\nBody\n`,
    );
    expect(skill.meta.description).toBe('line one line two line three');
  });

  it('throws when frontmatter is missing', () => {
    expect(() => parseSkill('no frontmatter here\n')).toThrow(/missing frontmatter/);
  });

  it('throws when a required string field is missing', () => {
    expect(() =>
      parseSkill(`---\nname: only\ndescription: only\n---\nbody`),
    ).toThrow(/missing or non-string 'id'/);
  });

  it('throws when an unparsable line appears', () => {
    expect(() =>
      parseSkill(`---\nid: ok\nname: ok\ndescription: ok\n-- not yaml --\n---\nbody`),
    ).toThrow(/cannot parse line/);
  });

  it('rejects a non-array applies_to', () => {
    expect(() =>
      parseSkill(`---\nid: x\nname: x\ndescription: x\napplies_to: just-a-string\n---\nbody`),
    ).toThrow(/'applies_to' must be a string array/);
  });
});
