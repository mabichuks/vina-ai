import { useEffect } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { AppRouter } from './router.js';
import { queryClient } from './store/query-client.js';
import { useUiStore } from './store/ui-store.js';
import { Toasts } from './components/Toasts.js';

/**
 * Sync the persisted theme to <html data-theme> so token CSS sees it before
 * the rest of the tree paints. Done in an effect so SSR-shaped tools that
 * pre-render are happy; Vite's dev/build is a CSR-only setup so this runs once.
 */
function useThemeAttribute(): void {
  const theme = useUiStore((s) => s.theme);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
}

export function App(): JSX.Element {
  useThemeAttribute();
  return (
    <QueryClientProvider client={queryClient}>
      <AppRouter />
      <Toasts />
    </QueryClientProvider>
  );
}
