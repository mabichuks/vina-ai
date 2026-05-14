import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useAuthStore } from '../store/auth-store.js';

export interface BootstrapResponse {
  version: string;
  token: string;
  onboarded: boolean;
}

/**
 * Fetches `/api/bootstrap`, persists the bearer token in the auth store, and
 * exposes the `onboarded` flag so the router can decide between the wizard
 * and the dashboard. Per the spec, this is the only un-gated endpoint.
 *
 * The token is set synchronously inside the queryFn (not in a useEffect) so
 * that any sibling queries that mount in the same render cycle and read
 * `getToken()` already see the new value. Setting via useEffect raced with
 * those queries and produced spurious "Missing bearer token" 401s.
 */
export function useBootstrap(): {
  data: BootstrapResponse | undefined;
  isLoading: boolean;
  error: Error | null;
} {
  const query = useQuery<BootstrapResponse>({
    queryKey: ['bootstrap'],
    queryFn: async () => {
      const data = await api<BootstrapResponse>('/api/bootstrap');
      useAuthStore.getState().setToken(data.token);
      return data;
    },
    staleTime: Infinity,
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: (query.error as Error | null) ?? null,
  };
}
