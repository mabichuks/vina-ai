import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSkillsSourceDir, VENDORED_SKILL_IDS } from '../src/index.js';

/**
 * The vendored skills are a read-only in-repo snapshot of the odytrice/jobs
 * harness, pinned by `skills/harness-version.json`. This test guards the
 * vendoring contract: exactly the eight skill dirs, each with `SKILL.md` and
 * (where the harness has one) `references/`, and none of the harness's
 * `scripts/` or `assets/` — Vina's tools, renderer, DB, and web UI replace
 * them, so only procedure prose ships.
 */
describe('vendored skills', () => {
  const skillsDir = defaultSkillsSourceDir();

  it('resolves the vendored skills dir under the plugin package', () => {
    expect(path.basename(skillsDir)).toBe('skills');
    expect(fs.existsSync(path.join(skillsDir, 'harness-version.json'))).toBe(true);
  });

  it('has exactly the eight skill directories', () => {
    const dirs = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual([...VENDORED_SKILL_IDS].sort());
  });

  it('every skill has a SKILL.md and no scripts/ or assets/', () => {
    for (const id of VENDORED_SKILL_IDS) {
      const dir = path.join(skillsDir, id);
      expect(fs.existsSync(path.join(dir, 'SKILL.md')), `${id}/SKILL.md`).toBe(true);
      expect(fs.existsSync(path.join(dir, 'scripts')), `${id}/scripts leaked`).toBe(false);
      expect(fs.existsSync(path.join(dir, 'assets')), `${id}/assets leaked`).toBe(false);
    }
  });

  it('skills with references ship only markdown references', () => {
    for (const id of VENDORED_SKILL_IDS) {
      const refs = path.join(skillsDir, id, 'references');
      if (!fs.existsSync(refs)) continue;
      for (const file of walk(refs)) {
        expect(file.endsWith('.md'), `${id}/references non-markdown file ${file}`).toBe(true);
      }
    }
  });

  it('the manifest records commit 5fdb1d1, the date, and all eight skills', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(skillsDir, 'harness-version.json'), 'utf8'),
    ) as { source: string; commit: string; date: string; skills: string[] };
    expect(manifest.source).toBe('github.com/odytrice/jobs');
    expect(manifest.commit).toBe('5fdb1d1');
    expect(manifest.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect([...manifest.skills].sort()).toEqual([...VENDORED_SKILL_IDS].sort());
  });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
