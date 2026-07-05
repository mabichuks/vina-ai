import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSkillRegistry } from '../../src/skills/registry.js';

const DEFAULTS_DIR = fileURLToPath(new URL('../../skills/', import.meta.url));

let overridesDir: string;
let altDefaults: string;

beforeEach(async () => {
  overridesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vina-skills-test-'));
  altDefaults = await fs.mkdtemp(path.join(os.tmpdir(), 'vina-skills-def-'));
});
afterEach(async () => {
  await fs.rm(overridesDir, { recursive: true, force: true });
  await fs.rm(altDefaults, { recursive: true, force: true });
});

async function writeSkill(
  baseDir: string,
  id: string,
  meta: {
    name?: string;
    description?: string;
    applies_to?: string[];
    capabilities?: string[];
    editable_by_user?: boolean;
    version?: number;
  },
  body: string,
): Promise<void> {
  const dir = path.join(baseDir, id);
  await fs.mkdir(dir, { recursive: true });
  const fm = [
    '---',
    `id: ${id}`,
    `name: ${meta.name ?? id}`,
    `description: ${meta.description ?? 'A test skill.'}`,
    meta.applies_to ? `applies_to: [${meta.applies_to.join(', ')}]` : '',
    meta.capabilities ? `capabilities: [${meta.capabilities.join(', ')}]` : '',
    meta.editable_by_user !== undefined ? `editable_by_user: ${meta.editable_by_user}` : '',
    meta.version !== undefined ? `version: ${meta.version}` : '',
    '---',
    '',
    body,
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');
  await fs.writeFile(path.join(dir, 'SKILL.md'), fm, 'utf8');
}

describe('createSkillRegistry — packaged defaults', () => {
  it('lists the packaged browser-apply skill', async () => {
    const reg = createSkillRegistry({ defaultsDir: DEFAULTS_DIR });
    const all = await reg.list();
    const ids = all.map((s) => s.id);
    expect(ids).toContain('browser-apply');
    const browserApply = all.find((s) => s.id === 'browser-apply')!;
    expect(browserApply.source).toBe('default');
    expect(browserApply.editable_by_user).toBe(false);
  });

  it('index() omits body but exposes description', async () => {
    const reg = createSkillRegistry({ defaultsDir: DEFAULTS_DIR });
    const list = await reg.index();
    for (const s of list) {
      expect(typeof s.description).toBe('string');
      expect(s.description.length).toBeGreaterThan(0);
      expect((s as unknown as { body?: unknown }).body).toBeUndefined();
    }
  });

  it('load() returns the full body lazily', async () => {
    const reg = createSkillRegistry({ defaultsDir: DEFAULTS_DIR });
    const full = await reg.load('browser-apply');
    expect(full.body).toMatch(/Interaction model/i);
  });
});

describe('createSkillRegistry — override semantics', () => {
  it('user override of a packaged skill shadows the default and is tagged source=override', async () => {
    await writeSkill(altDefaults, 'pkg', { name: 'Packaged' }, 'Packaged body.');
    await writeSkill(overridesDir, 'pkg', { name: 'Overridden' }, 'Override body.');
    const reg = createSkillRegistry({
      defaultsDir: altDefaults,
      overridesDir,
    });
    const loaded = await reg.load('pkg');
    expect(loaded.name).toBe('Overridden');
    expect(loaded.body).toBe('Override body.');
    expect(loaded.source).toBe('override');
  });

  it('a user-only skill (no packaged counterpart) is tagged source=user', async () => {
    await writeSkill(overridesDir, 'user-skill', { name: 'Mine' }, 'Custom body.');
    const reg = createSkillRegistry({
      defaultsDir: altDefaults,
      overridesDir,
    });
    const loaded = await reg.load('user-skill');
    expect(loaded.source).toBe('user');
    expect(loaded.body).toBe('Custom body.');
  });

  it('list() returns the union of defaults and overrides', async () => {
    await writeSkill(altDefaults, 'a', {}, 'a');
    await writeSkill(altDefaults, 'b', {}, 'b');
    await writeSkill(overridesDir, 'c', {}, 'c');
    const reg = createSkillRegistry({
      defaultsDir: altDefaults,
      overridesDir,
    });
    const ids = (await reg.list()).map((s) => s.id);
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('rejects an override whose frontmatter id mismatches its directory', async () => {
    await writeSkill(altDefaults, 'real', {}, 'real');
    // Hand-craft a SKILL.md with mismatching id field.
    const dir = path.join(overridesDir, 'real');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      [
        '---',
        'id: spoof',
        'name: Sneaky',
        'description: should not load',
        '---',
        '',
        'body',
      ].join('\n'),
      'utf8',
    );
    const reg = createSkillRegistry({
      defaultsDir: altDefaults,
      overridesDir,
    });
    await expect(reg.load('real')).rejects.toThrow(
      /frontmatter id 'spoof' does not match directory/,
    );
  });
});

describe('createSkillRegistry — index filtering', () => {
  it('index(graph) returns skills declaring that graph in applies_to', async () => {
    await writeSkill(altDefaults, 'apply-only', { applies_to: ['apply'] }, 'a');
    await writeSkill(altDefaults, 'score-only', { applies_to: ['score'] }, 'b');
    await writeSkill(altDefaults, 'universal', {}, 'c');
    const reg = createSkillRegistry({ defaultsDir: altDefaults });

    const applySkills = await reg.index('apply');
    const ids = applySkills.map((s) => s.id).sort();
    expect(ids).toEqual(['apply-only', 'universal']);
  });
});

describe('createSkillRegistry — capability clamp', () => {
  it('strips capabilities not in the allowlist on load', async () => {
    await writeSkill(
      altDefaults,
      'cap-test',
      { capabilities: ['snapshot', 'forbidden-cap', 'fillField'] },
      'b',
    );
    const reg = createSkillRegistry({
      defaultsDir: altDefaults,
      capabilityAllowlist: ['snapshot', 'fillField'],
    });
    const loaded = await reg.load('cap-test');
    expect(loaded.capabilities).toEqual(['snapshot', 'fillField']);
  });

  it('passes all capabilities through when no allowlist is configured', async () => {
    await writeSkill(
      altDefaults,
      'no-clamp',
      { capabilities: ['snapshot', 'something-weird'] },
      'b',
    );
    const reg = createSkillRegistry({ defaultsDir: altDefaults });
    const loaded = await reg.load('no-clamp');
    expect(loaded.capabilities).toEqual(['snapshot', 'something-weird']);
  });
});

describe('createSkillRegistry — caching', () => {
  it('caches load() until invalidate()', async () => {
    await writeSkill(altDefaults, 'cache-me', {}, 'body-1');
    const reg = createSkillRegistry({ defaultsDir: altDefaults });
    const a = await reg.load('cache-me');
    const b = await reg.load('cache-me');
    expect(a).toBe(b);
    reg.invalidate('cache-me');
    const c = await reg.load('cache-me');
    expect(a).not.toBe(c);
  });
});
