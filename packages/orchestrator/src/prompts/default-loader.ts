import {
  createPromptLoader,
  resolveDefaultsDir,
  type PromptLoader,
} from './loader.js';

let cached: PromptLoader | null = null;

/**
 * Module-level singleton pointing at the packaged defaults directory. Used
 * by graphs when no caller-supplied loader is provided. The server passes
 * its own loader (with `overridesDir`) into graphs that should honour user
 * overrides — see `tools/types.ts` for the eventual injection seam.
 */
export function getDefaultPromptLoader(): PromptLoader {
  if (cached) return cached;
  cached = createPromptLoader({
    defaultsDir: resolveDefaultsDir(import.meta.url),
  });
  return cached;
}

/** Test seam — clears the singleton between cases that swap defaults dirs. */
export function _resetDefaultPromptLoader(): void {
  cached = null;
}
