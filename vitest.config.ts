import { defineConfig } from 'vitest/config';

export default defineConfig({
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
