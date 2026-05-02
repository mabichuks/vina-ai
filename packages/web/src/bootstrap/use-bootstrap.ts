import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
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
 */
export function useBootstrap(): {
  data: BootstrapResponse | undefined;
  isLoading: boolean;
  error: Error | null;
} {
  const setToken = useAuthStore((s) => s.setToken);

  const query = useQuery<BootstrapResponse>({
    queryKey: ['bootstrap'],
    queryFn: () => api<BootstrapResponse>('/api/bootstrap'),
    staleTime: Infinity,
  });

  useEffect(() => {
    if (query.data?.token) setToken(query.data.token);
  }, [query.data?.token, setToken]);

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: (query.error as Error | null) ?? null,
  };
}
