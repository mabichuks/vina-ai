import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  optionalBoolean,
  optionalNumber,
  optionalStringArray,
  parseFrontmatter,
  requireString,
} from '../utils/frontmatter.js';

/**
 * Metadata declared in a skill file's YAML frontmatter. Mirrors the
 * frontmatter contract from `docs/skill-system.md`.
 */
export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  applies_to?: string[];
  capabilities?: string[];
  editable_by_user?: boolean;
  version?: number;
}

export interface Skill {
  meta: SkillMeta;
  /** Markdown body — pre-loaded into the apply graph's system prompt. */
  body: string;
}

export async function loadSkill(target: string | URL): Promise<Skill> {
  const filePath =
    target instanceof URL
      ? fileURLToPath(target)
      : target.startsWith('file:')
        ? fileURLToPath(target)
        : target;
  const raw = await fs.readFile(filePath, 'utf8');
  return parseSkill(raw, filePath);
}

export function parseSkill(raw: string, sourcePath?: string): Skill {
  const parsed = parseFrontmatter(raw, sourcePath);
  const ctx = sourcePath ? `(${sourcePath})` : 'skill';
  const meta: SkillMeta = {
    id: requireString(parsed.frontmatter, 'id', ctx),
    name: requireString(parsed.frontmatter, 'name', ctx),
    description: requireString(parsed.frontmatter, 'description', ctx),
    applies_to: optionalStringArray(parsed.frontmatter, 'applies_to', ctx),
    capabilities: optionalStringArray(parsed.frontmatter, 'capabilities', ctx),
    editable_by_user: optionalBoolean(parsed.frontmatter, 'editable_by_user', ctx),
    version: optionalNumber(parsed.frontmatter, 'version', ctx),
  };
  return { meta, body: parsed.body };
}

/**
 * Resolve a skill id to its canonical path inside the orchestrator's
 * `skills/` directory. Works in both source (tests) and built (dist)
 * layouts because skills live one level above either `src` or `dist`.
 */
export function resolveSkillPath(skillId: string, fromFileUrl: string): string {
  const here = path.dirname(fileURLToPath(fromFileUrl));
  let dir = here;
  for (let i = 0; i < 5; i++) {
    if (path.basename(dir) === 'src' || path.basename(dir) === 'dist') {
      return path.join(dir, '..', 'skills', skillId, 'SKILL.md');
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`resolveSkillPath: could not locate skills/ above ${here}`);
}
