import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseFrontmatter,
  requireBoolean,
  requireNumber,
  requireString,
  requireStringArray,
} from '../utils/frontmatter.js';

/**
 * One loaded prompt. `source` distinguishes a packaged default from a user
 * override in `<data-dir>/prompts/`. Placeholders `{{name}}` in `body` are
 * validated at load time and substituted by `render`.
 */
export interface PromptDoc {
  id: string;
  title: string;
  graph: string;
  editableByUser: boolean;
  variables: string[];
  version: number;
  body: string;
  source: 'default' | 'override';
}

export interface PromptLoader {
  /** Resolve override-first, else default. */
  load(id: string): Promise<PromptDoc>;
  /** List every prompt id present in `defaultsDir`. */
  list(): Promise<PromptDoc[]>;
  /** Render with `{{var}}` substitution. Throws on undeclared/missing vars. */
  render(id: string, vars?: Record<string, string>): Promise<string>;
  /** Drop a cache entry — called after writes from the CRUD endpoint. */
  invalidate(id?: string): void;
}

export interface CreatePromptLoaderOptions {
  /** Packaged defaults directory. Typically `<orchestrator>/prompts/`. */
  defaultsDir: string;
  /** User override directory. Optional; absent means defaults only. */
  overridesDir?: string;
}

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

function findPlaceholders(body: string): Set<string> {
  const out = new Set<string>();
  for (const m of body.matchAll(PLACEHOLDER_RE)) {
    out.add(m[1]!);
  }
  return out;
}

async function readPromptFile(
  filePath: string,
  source: 'default' | 'override',
): Promise<PromptDoc> {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = parseFrontmatter(raw, filePath);
  const ctx = `prompt ${filePath}`;
  const doc: PromptDoc = {
    id: requireString(parsed.frontmatter, 'id', ctx),
    title: requireString(parsed.frontmatter, 'title', ctx),
    graph: requireString(parsed.frontmatter, 'graph', ctx),
    editableByUser: requireBoolean(parsed.frontmatter, 'editable_by_user', ctx),
    variables: requireStringArray(parsed.frontmatter, 'variables', ctx),
    version: requireNumber(parsed.frontmatter, 'version', ctx),
    body: parsed.body,
    source,
  };

  const used = findPlaceholders(doc.body);
  for (const name of used) {
    if (!doc.variables.includes(name)) {
      throw new Error(
        `prompt ${doc.id}: body uses '{{${name}}}' but '${name}' is not declared in variables`,
      );
    }
  }
  return doc;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export function createPromptLoader(
  opts: CreatePromptLoaderOptions,
): PromptLoader {
  const cache = new Map<string, PromptDoc>();

  async function load(id: string): Promise<PromptDoc> {
    const cached = cache.get(id);
    if (cached) return cached;

    if (opts.overridesDir) {
      const overridePath = path.join(opts.overridesDir, `${id}.md`);
      if (await fileExists(overridePath)) {
        const doc = await readPromptFile(overridePath, 'override');
        if (doc.id !== id) {
          throw new Error(
            `prompt override ${id}: frontmatter id '${doc.id}' does not match filename`,
          );
        }
        // Variables in the override must be a subset of the default's — the
        // graph only supplies the default-declared variables, so introducing
        // new ones would crash render time.
        const def = await readPromptFile(
          path.join(opts.defaultsDir, `${id}.md`),
          'default',
        );
        for (const v of doc.variables) {
          if (!def.variables.includes(v)) {
            throw new Error(
              `prompt override ${id}: variable '${v}' not declared in default`,
            );
          }
        }
        cache.set(id, doc);
        return doc;
      }
    }

    const defaultPath = path.join(opts.defaultsDir, `${id}.md`);
    const doc = await readPromptFile(defaultPath, 'default');
    if (doc.id !== id) {
      throw new Error(
        `prompt default ${id}: frontmatter id '${doc.id}' does not match filename`,
      );
    }
    cache.set(id, doc);
    return doc;
  }

  async function list(): Promise<PromptDoc[]> {
    const entries = await fs.readdir(opts.defaultsDir);
    const ids = entries.filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
    return Promise.all(ids.map((id) => load(id)));
  }

  async function render(
    id: string,
    vars: Record<string, string> = {},
  ): Promise<string> {
    const doc = await load(id);
    return doc.body.replace(PLACEHOLDER_RE, (_, name) => {
      // findPlaceholders + load-time check already guarantees name ∈ variables.
      const value = vars[name];
      if (value === undefined) {
        throw new Error(
          `prompt ${doc.id}: variable '${name}' not supplied at render time`,
        );
      }
      return value;
    });
  }

  function invalidate(id?: string): void {
    if (id) cache.delete(id);
    else cache.clear();
  }

  return { load, list, render, invalidate };
}

/**
 * Resolve the packaged prompts directory next to `src/` or `dist/`.
 * Mirrors `resolveSkillPath`.
 */
export function resolveDefaultsDir(fromFileUrl: string): string {
  const here = path.dirname(fileURLToPath(fromFileUrl));
  let dir = here;
  for (let i = 0; i < 5; i++) {
    if (path.basename(dir) === 'src' || path.basename(dir) === 'dist') {
      return path.join(dir, '..', 'prompts');
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`resolveDefaultsDir: could not locate prompts/ above ${here}`);
}
