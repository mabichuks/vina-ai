import { QueryClient } from '@tanstack/react-query';

/**
 * Single QueryClient for the app. Sensible defaults for a local-only tool —
 * no aggressive refetch on focus; the WS gateway invalidates on real change.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});
