import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

export interface SystemStatusResponse {
  version: string;
  started_at: string;
  scheduler: { running: boolean; next_run_at: string | null };
  queue: { pending: number; running: number };
  active_provider: { kind: string; model: string } | null;
  sources: { id: string; kind: 'browser' | 'api'; enabled: boolean; ok: boolean | null }[];
}

export function useSystemStatus(): {
  data: SystemStatusResponse | undefined;
  isLoading: boolean;
} {
  const q = useQuery<SystemStatusResponse>({
    queryKey: ['system-status'],
    queryFn: () => api<SystemStatusResponse>('/api/system/status'),
    refetchInterval: 5_000,
  });
  return { data: q.data, isLoading: q.isLoading };
}

export function useTogglePause(): {
  pause: () => void;
  resume: () => void;
  isPending: boolean;
} {
  const qc = useQueryClient();
  const pause = useMutation({
    mutationFn: () => api('/api/system/pause', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['system-status'] }),
  });
  const resume = useMutation({
    mutationFn: () => api('/api/system/resume', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['system-status'] }),
  });
  return {
    pause: () => pause.mutate(),
    resume: () => resume.mutate(),
    isPending: pause.isPending || resume.isPending,
  };
}
