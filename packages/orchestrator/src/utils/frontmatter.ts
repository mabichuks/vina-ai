/**
 * Tiny YAML frontmatter parser. Shared by skills and prompts so both speak
 * the same subset: scalar strings, folded scalars (`>` / `|`), inline arrays
 * (`[a, b]`), booleans, integers. Anything outside that throws — better a
 * loud failure than a silent mis-parse.
 */

export interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseFrontmatter(raw: string, sourcePath?: string): ParsedFrontmatter {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) {
    throw new Error(
      `missing frontmatter${sourcePath ? `: ${sourcePath}` : ''}`,
    );
  }
  const [, yaml, body] = m;
  return {
    frontmatter: parseYaml(yaml!),
    body: (body ?? '').replace(/^\r?\n+/, '').replace(/\s+$/, ''),
  };
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

function parseYaml(yaml: string): Record<string, unknown> {
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
    if (foldedKey && /^\s+/.test(line) && line.trim().length > 0) {
      foldedChunks.push(line.trim());
      continue;
    }
    if (foldedKey && line.trim().length === 0) {
      foldedChunks.push('');
      continue;
    }
    flushFolded();

    if (line.trim().length === 0) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      throw new Error(`frontmatter: cannot parse line: ${line}`);
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

  return result;
}

// --- Field accessors --------------------------------------------------------

export function requireString(
  obj: Record<string, unknown>,
  key: string,
  ctx?: string,
): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`frontmatter${ctx ? ` ${ctx}` : ''}: missing or non-string '${key}'`);
  }
  return v;
}

export function optionalStringArray(
  obj: Record<string, unknown>,
  key: string,
  ctx?: string,
): string[] | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new Error(`frontmatter${ctx ? ` ${ctx}` : ''}: '${key}' must be a string array`);
  }
  return v as string[];
}

export function requireStringArray(
  obj: Record<string, unknown>,
  key: string,
  ctx?: string,
): string[] {
  const v = optionalStringArray(obj, key, ctx);
  if (v === undefined) {
    throw new Error(`frontmatter${ctx ? ` ${ctx}` : ''}: missing '${key}' (string array)`);
  }
  return v;
}

export function optionalBoolean(
  obj: Record<string, unknown>,
  key: string,
  ctx?: string,
): boolean | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') {
    throw new Error(`frontmatter${ctx ? ` ${ctx}` : ''}: '${key}' must be boolean`);
  }
  return v;
}

export function requireBoolean(
  obj: Record<string, unknown>,
  key: string,
  ctx?: string,
): boolean {
  const v = optionalBoolean(obj, key, ctx);
  if (v === undefined) {
    throw new Error(`frontmatter${ctx ? ` ${ctx}` : ''}: missing '${key}' (boolean)`);
  }
  return v;
}

export function optionalNumber(
  obj: Record<string, unknown>,
  key: string,
  ctx?: string,
): number | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number') {
    throw new Error(`frontmatter${ctx ? ` ${ctx}` : ''}: '${key}' must be a number`);
  }
  return v;
}

export function requireNumber(
  obj: Record<string, unknown>,
  key: string,
  ctx?: string,
): number {
  const v = optionalNumber(obj, key, ctx);
  if (v === undefined) {
    throw new Error(`frontmatter${ctx ? ` ${ctx}` : ''}: missing '${key}' (number)`);
  }
  return v;
}
