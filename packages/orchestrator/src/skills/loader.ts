import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

/**
 * Load and parse a `SKILL.md` from disk. Accepts a filesystem path or a
 * `file:`-style URL. The frontmatter parser handles the shapes the spec
 * uses today: scalar strings, folded scalars (`description: >`), inline
 * arrays (`[a, b, c]`), booleans, and integers. Anything outside that set
 * throws — better to fail loudly than silently mis-parse.
 */
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
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) {
    throw new Error(
      `skill file missing frontmatter${sourcePath ? `: ${sourcePath}` : ''}`,
    );
  }
  const [, yaml, body] = m;
  const meta = parseFrontmatter(yaml!);
  return { meta, body: (body ?? '').trim() };
}

function parseInlineValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return trimmed;
}

function parseFrontmatter(yaml: string): SkillMeta {
  const lines = yaml.split(/\r?\n/);
  const result: Record<string, unknown> = {};
  let foldedKey: string | null = null;
  let foldedChunks: string[] = [];

  function flushFolded(): void {
    if (foldedKey) {
      result[foldedKey] = foldedChunks.join(' ').trim();
      foldedKey = null;
      foldedChunks = [];
    }
  }

  for (const line of lines) {
    // Folded continuation: indented lines after `key: >`
    if (foldedKey && /^\s+/.test(line) && line.trim().length > 0) {
      foldedChunks.push(line.trim());
      continue;
    }
    // Blank line inside a folded block — separates paragraphs, collapse to space.
    if (foldedKey && line.trim().length === 0) {
      foldedChunks.push('');
      continue;
    }
    // Otherwise the folded block is done — flush and continue parsing.
    flushFolded();

    if (line.trim().length === 0) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      throw new Error(`skill frontmatter: cannot parse line: ${line}`);
    }
    const [, key, value] = match;
    const trimmed = value!.trim();
    if (trimmed === '>' || trimmed === '|') {
      foldedKey = key!;
      foldedChunks = [];
      continue;
    }
    result[key!] = parseInlineValue(trimmed);
  }
  flushFolded();

  return {
    id: stringField(result, 'id'),
    name: stringField(result, 'name'),
    description: stringField(result, 'description'),
    applies_to: optionalStringArrayField(result, 'applies_to'),
    capabilities: optionalStringArrayField(result, 'capabilities'),
    editable_by_user: optionalBooleanField(result, 'editable_by_user'),
    version: optionalNumberField(result, 'version'),
  };
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`skill frontmatter: missing or non-string '${key}'`);
  }
  return v;
}

function optionalStringArrayField(
  obj: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new Error(`skill frontmatter: '${key}' must be a string array`);
  }
  return v as string[];
}

function optionalBooleanField(
  obj: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') {
    throw new Error(`skill frontmatter: '${key}' must be boolean`);
  }
  return v;
}

function optionalNumberField(
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number') {
    throw new Error(`skill frontmatter: '${key}' must be a number`);
  }
  return v;
}

/**
 * Resolve a skill id to its canonical path inside the orchestrator's
 * `skills/` directory. Works in both source (tests) and built (dist)
 * layouts because skills live one level above either `src` or `dist`.
 */
export function resolveSkillPath(skillId: string, fromFileUrl: string): string {
  const here = path.dirname(fileURLToPath(fromFileUrl));
  // here is .../src/<something>/ or .../dist/<something>/ — climb until we find a
  // sibling `skills/` directory. Cap the climb to keep this O(1).
  let dir = here;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'skills', skillId, 'SKILL.md');
    // We do not stat here — return the path; the caller's fs.readFile will fail
    // loudly if it doesn't exist.
    if (path.basename(dir) === 'src' || path.basename(dir) === 'dist') {
      return path.join(dir, '..', 'skills', skillId, 'SKILL.md');
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    // Help linting see the unused var is intentional.
    void candidate;
  }
  throw new Error(`resolveSkillPath: could not locate skills/ above ${here}`);
}
