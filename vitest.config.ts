import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Mirror packages/web/vite.config.ts so web component tests can resolve @/…
      '@': path.resolve(root, 'packages/web/src'),
    },
  },
  test: {
    include: ['packages/*/tests/**/*.{test,spec}.{ts,tsx}', 'tests/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/e2e/**'],
    passWithNoTests: true,
    // reason: web package tests render React hooks and need a DOM environment;
    // happy-dom is used over jsdom to avoid ESM interop issues in the monorepo.
    environmentMatchGlobs: [['packages/web/tests/**', 'happy-dom']],
    setupFiles: ['packages/web/tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.{test,spec}.{ts,tsx}', '**/dist/**'],
    },
  },
});
