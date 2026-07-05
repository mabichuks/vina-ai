import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSkillRegistry } from '../../src/skills/registry.js';
import { createSkillTools } from '../../src/tools/skill-tools.js';

let defaultsDir: string;

beforeEach(async () => {
  defaultsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vina-skill-tools-'));
});
afterEach(async () => {
  await fs.rm(defaultsDir, { recursive: true, force: true });
});

async function writeSkill(
  id: string,
  meta: { name?: string; applies_to?: string[] },
  body: string,
): Promise<void> {
  const dir = path.join(defaultsDir, id);
  await fs.mkdir(dir, { recursive: true });
  const lines = [
    '---',
    `id: ${id}`,
    `name: ${meta.name ?? id}`,
    `description: ${id} description`,
    meta.applies_to ? `applies_to: [${meta.applies_to.join(', ')}]` : '',
    'editable_by_user: true',
    'version: 1',
    '---',
    '',
    body,
  ].filter((l) => l !== '');
  await fs.writeFile(path.join(dir, 'SKILL.md'), lines.join('\n'), 'utf8');
}

describe('createSkillTools', () => {
  it('index() forwards to registry.index() with the given graph', async () => {
    await writeSkill('a', { applies_to: ['apply'] }, 'a body');
    await writeSkill('b', { applies_to: ['score'] }, 'b body');
    const tools = createSkillTools(createSkillRegistry({ defaultsDir }));
    const summaries = await tools.index({ graph: 'apply' });
    expect(summaries.map((s) => s.id)).toEqual(['a']);
    // Body never leaks through index().
    expect((summaries[0] as unknown as { body?: unknown }).body).toBeUndefined();
  });

  it('load() returns the full body', async () => {
    await writeSkill('a', {}, 'a body line\nsecond line');
    const tools = createSkillTools(createSkillRegistry({ defaultsDir }));
    const full = await tools.load({ id: 'a' });
    expect(full.body).toBe('a body line\nsecond line');
  });
});
