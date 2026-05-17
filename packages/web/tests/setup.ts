// Extends vitest's expect with @testing-library/jest-dom matchers
// (toBeInTheDocument, toHaveTextContent, etc.) for web package tests.
// Guard against non-DOM environments (server, CLI, orchestrator tests) that
// share the root vitest config's setupFiles list.
if (typeof window !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
}
