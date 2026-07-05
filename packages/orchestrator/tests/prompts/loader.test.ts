import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createPromptLoader } from '../../src/prompts/loader.js';

const DEFAULTS_DIR = fileURLToPath(new URL('../../prompts/', import.meta.url));

let overridesDir: string;

beforeEach(async () => {
  overridesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vina-prompts-test-'));
});
afterEach(async () => {
  await fs.rm(overridesDir, { recursive: true, force: true });
});

describe('createPromptLoader — defaults', () => {
  it('loads packaged defaults with frontmatter parsed', async () => {
    const loader = createPromptLoader({ defaultsDir: DEFAULTS_DIR });
    const doc = await loader.load('score');
    expect(doc.id).toBe('score');
    expect(doc.graph).toBe('score-job');
    expect(doc.editableByUser).toBe(true);
    expect(doc.variables).toEqual([]);
    expect(doc.source).toBe('default');
    expect(doc.body).toMatch(/calibrated job-fit scorer/);
  });

  it('lists every .md in defaultsDir', async () => {
    const loader = createPromptLoader({ defaultsDir: DEFAULTS_DIR });
    const all = await loader.list();
    const ids = all.map((d) => d.id).sort();
    expect(ids).toEqual(['score', 'system-base', 'tailor-cover-letter', 'tailor-cv']);
  });

  it('caches successive loads', async () => {
    const loader = createPromptLoader({ defaultsDir: DEFAULTS_DIR });
    const a = await loader.load('score');
    const b = await loader.load('score');
    expect(a).toBe(b);
  });

  it('invalidate() drops the cache entry', async () => {
    const loader = createPromptLoader({ defaultsDir: DEFAULTS_DIR });
    const a = await loader.load('score');
    loader.invalidate('score');
    const b = await loader.load('score');
    expect(a).not.toBe(b);
    expect(a.body).toBe(b.body);
  });
});

describe('createPromptLoader — override-wins', () => {
  it('returns the override when present in overridesDir', async () => {
    await fs.writeFile(
      path.join(overridesDir, 'score.md'),
      [
        '---',
        'id: score',
        'title: Custom Score',
        'graph: score-job',
        'editable_by_user: true',
        'variables: []',
        'version: 2',
        '---',
        '',
        'My custom scoring prompt.',
        '',
      ].join('\n'),
      'utf8',
    );
    const loader = createPromptLoader({
      defaultsDir: DEFAULTS_DIR,
      overridesDir,
    });
    const doc = await loader.load('score');
    expect(doc.source).toBe('override');
    expect(doc.title).toBe('Custom Score');
    expect(doc.body).toBe('My custom scoring prompt.');
    expect(doc.version).toBe(2);
  });

  it('falls back to default when override file is absent', async () => {
    const loader = createPromptLoader({
      defaultsDir: DEFAULTS_DIR,
      overridesDir,
    });
    const doc = await loader.load('score');
    expect(doc.source).toBe('default');
  });

  it('rejects an override declaring a variable not in the default', async () => {
    await fs.writeFile(
      path.join(overridesDir, 'score.md'),
      [
        '---',
        'id: score',
        'title: Custom Score',
        'graph: score-job',
        'editable_by_user: true',
        'variables: [newVar]',
        'version: 2',
        '---',
        '',
        'Body with {{newVar}}',
        '',
      ].join('\n'),
      'utf8',
    );
    const loader = createPromptLoader({
      defaultsDir: DEFAULTS_DIR,
      overridesDir,
    });
    await expect(loader.load('score')).rejects.toThrow(
      /variable 'newVar' not declared in default/,
    );
  });

  it('rejects an override whose frontmatter id mismatches its filename', async () => {
    await fs.writeFile(
      path.join(overridesDir, 'score.md'),
      [
        '---',
        'id: not-score',
        'title: Mismatch',
        'graph: score-job',
        'editable_by_user: true',
        'variables: []',
        'version: 1',
        '---',
        '',
        'Body',
        '',
      ].join('\n'),
      'utf8',
    );
    const loader = createPromptLoader({
      defaultsDir: DEFAULTS_DIR,
      overridesDir,
    });
    await expect(loader.load('score')).rejects.toThrow(
      /frontmatter id 'not-score' does not match filename/,
    );
  });
});

describe('createPromptLoader — render', () => {
  it('returns the body unchanged when there are no placeholders', async () => {
    const loader = createPromptLoader({ defaultsDir: DEFAULTS_DIR });
    const rendered = await loader.render('score', {});
    const doc = await loader.load('score');
    expect(rendered).toBe(doc.body);
  });

  it('substitutes {{vars}} that are declared', async () => {
    await fs.writeFile(
      path.join(overridesDir, 'score.md'),
      [
        '---',
        'id: score',
        'title: With variables',
        'graph: score-job',
        'editable_by_user: true',
        'variables: []',
        'version: 1',
        '---',
        '',
        'Plain body, no vars.',
      ].join('\n'),
      'utf8',
    );
    // Use a fixture in overrides that DOES declare a variable allowed in defaults.
    // Default `score.md` declares variables: [], so an override can't introduce a
    // new var. Skip via a synthetic fixture in a clean defaults dir instead:
    const synthDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vina-prompts-syn-'));
    try {
      await fs.writeFile(
        path.join(synthDir, 'demo.md'),
        [
          '---',
          'id: demo',
          'title: Demo',
          'graph: demo',
          'editable_by_user: true',
          'variables: [name]',
          'version: 1',
          '---',
          '',
          'Hello, {{name}}!',
        ].join('\n'),
        'utf8',
      );
      const loader = createPromptLoader({ defaultsDir: synthDir });
      const out = await loader.render('demo', { name: 'Ada' });
      expect(out).toBe('Hello, Ada!');
    } finally {
      await fs.rm(synthDir, { recursive: true, force: true });
    }
  });

  it('throws when the body uses an undeclared placeholder', async () => {
    const synthDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vina-prompts-syn-'));
    try {
      await fs.writeFile(
        path.join(synthDir, 'bad.md'),
        [
          '---',
          'id: bad',
          'title: Bad',
          'graph: bad',
          'editable_by_user: true',
          'variables: []',
          'version: 1',
          '---',
          '',
          'Hello, {{name}}!',
        ].join('\n'),
        'utf8',
      );
      const loader = createPromptLoader({ defaultsDir: synthDir });
      await expect(loader.load('bad')).rejects.toThrow(
        /body uses '\{\{name\}\}' but 'name' is not declared/,
      );
    } finally {
      await fs.rm(synthDir, { recursive: true, force: true });
    }
  });

  it('throws when a declared variable is missing at render time', async () => {
    const synthDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vina-prompts-syn-'));
    try {
      await fs.writeFile(
        path.join(synthDir, 'greet.md'),
        [
          '---',
          'id: greet',
          'title: Greet',
          'graph: greet',
          'editable_by_user: true',
          'variables: [name]',
          'version: 1',
          '---',
          '',
          'Hello, {{name}}!',
        ].join('\n'),
        'utf8',
      );
      const loader = createPromptLoader({ defaultsDir: synthDir });
      await expect(loader.render('greet', {})).rejects.toThrow(
        /'name' not supplied at render time/,
      );
    } finally {
      await fs.rm(synthDir, { recursive: true, force: true });
    }
  });
});
