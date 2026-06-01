import {
  createSkillRegistry,
  resolveSkillsDefaultsDir,
  type SkillRegistry,
} from './registry.js';

let cached: SkillRegistry | null = null;

/**
 * Module-level singleton pointing at the packaged skills directory. Used by
 * graphs when no caller-supplied registry is provided. The server passes
 * its own registry (with `overridesDir` and a capability allowlist) into
 * graphs that should honour user overrides.
 */
export function getDefaultSkillRegistry(): SkillRegistry {
  if (cached) return cached;
  cached = createSkillRegistry({
    defaultsDir: resolveSkillsDefaultsDir(import.meta.url),
  });
  return cached;
}

/** Test seam — clears the singleton between cases that swap directories. */
export function _resetDefaultSkillRegistry(): void {
  cached = null;
}
