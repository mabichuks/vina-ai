import fs from 'node:fs';
import { chromium } from 'playwright';

export interface ChromiumInfo {
  available: boolean;
  executable_path: string | null;
  error?: string;
}

/**
 * Resolve Playwright's bundled Chromium executable and verify it exists on
 * disk. Returns an `available: false` envelope (rather than throwing) so
 * callers can surface the result through HTTP / CLI flows without try/catch
 * everywhere.
 */
export function getChromiumInfo(): ChromiumInfo {
  try {
    const exe = chromium.executablePath();
    if (exe && fs.existsSync(exe)) {
      return { available: true, executable_path: exe };
    }
    return { available: false, executable_path: exe || null };
  } catch (err) {
    return {
      available: false,
      executable_path: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
