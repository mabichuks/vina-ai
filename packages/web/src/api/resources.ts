import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CoverLetter,
  Cv,
  LlmProvider,
  LlmProviderInput,
  Profile,
  ProfileInput,
  SearchPreferences,
  SearchPreferencesInput,
  Settings,
  SettingsUpdate,
} from '@vina/shared';
import { api } from './client.js';

/* ------------------------------------------------------------------ */
/* Profile                                                             */
/* ------------------------------------------------------------------ */

export function useProfile(): { data: Profile | null; isLoading: boolean } {
  const q = useQuery<Profile | null>({
    queryKey: ['profile'],
    queryFn: async () => {
      try {
        return await api<Profile>('/api/profile');
      } catch (err) {
        if ((err as { code?: string }).code === 'not_found') return null;
        throw err;
      }
    },
  });
  return { data: q.data ?? null, isLoading: q.isLoading };
}

export function useSaveProfile(): {
  mutate: (input: ProfileInput | Partial<ProfileInput>, exists: boolean) => Promise<Profile>;
  isPending: boolean;
} {
  const qc = useQueryClient();
  const mut = useMutation<Profile, Error, { input: unknown; exists: boolean }>({
    mutationFn: ({ input, exists }) =>
      api<Profile>('/api/profile', {
        method: exists ? 'PATCH' : 'POST',
        body: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profile'] }),
  });
  return {
    mutate: (input, exists) => mut.mutateAsync({ input, exists }),
    isPending: mut.isPending,
  };
}

/* ------------------------------------------------------------------ */
/* LLM Providers                                                       */
/* ------------------------------------------------------------------ */

export function useLlmProviders(): { data: LlmProvider[]; isLoading: boolean } {
  const q = useQuery<LlmProvider[]>({
    queryKey: ['llm-providers'],
    queryFn: () => api<LlmProvider[]>('/api/llm-providers'),
  });
  return { data: q.data ?? [], isLoading: q.isLoading };
}

export function useCreateLlmProvider(): {
  mutate: (input: LlmProviderInput) => Promise<LlmProvider>;
  isPending: boolean;
} {
  const qc = useQueryClient();
  const mut = useMutation<LlmProvider, Error, LlmProviderInput>({
    mutationFn: (input) => api<LlmProvider>('/api/llm-providers', { method: 'POST', body: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['llm-providers'] });
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });
  return { mutate: (input) => mut.mutateAsync(input), isPending: mut.isPending };
}

/* ------------------------------------------------------------------ */
/* CVs                                                                 */
/* ------------------------------------------------------------------ */

export function useCvs(): { data: Cv[]; isLoading: boolean } {
  const q = useQuery<Cv[]>({ queryKey: ['cvs'], queryFn: () => api<Cv[]>('/api/cvs') });
  return { data: q.data ?? [], isLoading: q.isLoading };
}

export function useUploadCv(): {
  mutate: (file: File, label: string, isDefault?: boolean) => Promise<Cv>;
  isPending: boolean;
} {
  const qc = useQueryClient();
  const mut = useMutation<Cv, Error, { file: File; label: string; isDefault: boolean }>({
    mutationFn: async ({ file, label, isDefault }) => {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('label', label);
      if (isDefault) fd.append('is_default', 'true');
      // We can't use the JSON `api` helper for multipart; do the bearer attach
      // by hand here since FormData carries its own content-type with boundary.
      const { useAuthStore } = await import('../store/auth-store.js');
      const token = useAuthStore.getState().token;
      const res = await fetch('/api/cvs', {
        method: 'POST',
        headers: { authorization: `Bearer ${token ?? ''}` },
        body: fd,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Upload failed: ${res.status} ${text}`);
      }
      return (await res.json()) as Cv;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cvs'] }),
  });
  return {
    mutate: (file, label, isDefault = false) => mut.mutateAsync({ file, label, isDefault }),
    isPending: mut.isPending,
  };
}

/* ------------------------------------------------------------------ */
/* Cover Letters                                                       */
/* ------------------------------------------------------------------ */

export function useCoverLetters(): { data: CoverLetter[]; isLoading: boolean } {
  const q = useQuery<CoverLetter[]>({
    queryKey: ['cover-letters'],
    queryFn: () => api<CoverLetter[]>('/api/cover-letters'),
  });
  return { data: q.data ?? [], isLoading: q.isLoading };
}

export function useUploadCoverLetter(): {
  mutate: (file: File, label: string) => Promise<CoverLetter>;
  isPending: boolean;
} {
  const qc = useQueryClient();
  const mut = useMutation<CoverLetter, Error, { file: File; label: string }>({
    mutationFn: async ({ file, label }) => {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('label', label);
      const { useAuthStore } = await import('../store/auth-store.js');
      const token = useAuthStore.getState().token;
      const res = await fetch('/api/cover-letters', {
        method: 'POST',
        headers: { authorization: `Bearer ${token ?? ''}` },
        body: fd,
      });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      return (await res.json()) as CoverLetter;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cover-letters'] }),
  });
  return {
    mutate: (file, label) => mut.mutateAsync({ file, label }),
    isPending: mut.isPending,
  };
}

/* ------------------------------------------------------------------ */
/* Search Preferences                                                  */
/* ------------------------------------------------------------------ */

export function useSearchPreferences(): {
  data: SearchPreferences | null;
  isLoading: boolean;
} {
  const q = useQuery<SearchPreferences>({
    queryKey: ['search-preferences'],
    queryFn: () => api<SearchPreferences>('/api/search-preferences'),
  });
  return { data: q.data ?? null, isLoading: q.isLoading };
}

export function useSavePreferences(): {
  mutate: (input: SearchPreferencesInput) => Promise<SearchPreferences>;
  isPending: boolean;
} {
  const qc = useQueryClient();
  const mut = useMutation<SearchPreferences, Error, SearchPreferencesInput>({
    mutationFn: (input) =>
      api<SearchPreferences>('/api/search-preferences', { method: 'PUT', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['search-preferences'] }),
  });
  return { mutate: (input) => mut.mutateAsync(input), isPending: mut.isPending };
}

/* ------------------------------------------------------------------ */
/* Schedules                                                           */
/* ------------------------------------------------------------------ */

export interface ScheduleRow {
  id: string;
  cron_expression: string;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
}

export function useSchedules(): { data: ScheduleRow[]; isLoading: boolean } {
  const q = useQuery<ScheduleRow[]>({
    queryKey: ['schedules'],
    queryFn: () => api<ScheduleRow[]>('/api/schedules'),
  });
  return { data: q.data ?? [], isLoading: q.isLoading };
}

export function useSaveSchedule(): {
  mutate: (cron: string, existing?: ScheduleRow | null) => Promise<ScheduleRow>;
  isPending: boolean;
} {
  const qc = useQueryClient();
  const mut = useMutation<
    ScheduleRow,
    Error,
    { cron: string; existing: ScheduleRow | null | undefined }
  >({
    mutationFn: ({ cron, existing }) =>
      existing
        ? api<ScheduleRow>(`/api/schedules/${existing.id}`, {
            method: 'PATCH',
            body: { cron_expression: cron },
          })
        : api<ScheduleRow>('/api/schedules', {
            method: 'POST',
            body: { cron_expression: cron, enabled: true },
          }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
  });
  return {
    mutate: (cron, existing) => mut.mutateAsync({ cron, existing }),
    isPending: mut.isPending,
  };
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export function useSettings(): { data: Settings | null; isLoading: boolean } {
  const q = useQuery<Settings>({
    queryKey: ['settings'],
    queryFn: () => api<Settings>('/api/settings'),
  });
  return { data: q.data ?? null, isLoading: q.isLoading };
}

export function useUpdateSettings(): {
  mutate: (patch: SettingsUpdate) => Promise<Settings>;
  isPending: boolean;
} {
  const qc = useQueryClient();
  const mut = useMutation<Settings, Error, SettingsUpdate>({
    mutationFn: (patch) => api<Settings>('/api/settings', { method: 'PATCH', body: patch }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      void qc.invalidateQueries({ queryKey: ['sites'] });
    },
  });
  return { mutate: (patch) => mut.mutateAsync(patch), isPending: mut.isPending };
}

/* ------------------------------------------------------------------ */
/* Sites                                                               */
/* ------------------------------------------------------------------ */

export interface SiteResponse {
  id: string;
  display_name: string;
  kind: 'browser' | 'api';
  enabled: boolean;
  has_session: boolean;
  session_valid_at: string | null;
  last_search_at: string | null;
}

export function useSites(): { data: SiteResponse[]; isLoading: boolean } {
  const q = useQuery<SiteResponse[]>({
    queryKey: ['sites'],
    queryFn: () => api<SiteResponse[]>('/api/sites'),
  });
  return { data: q.data ?? [], isLoading: q.isLoading };
}

export function useToggleSite(): {
  mutate: (id: string, enabled: boolean) => Promise<unknown>;
  isPending: boolean;
} {
  const qc = useQueryClient();
  const mut = useMutation<unknown, Error, { id: string; enabled: boolean }>({
    mutationFn: ({ id, enabled }) =>
      api(`/api/sites/${id}`, { method: 'PATCH', body: { enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sites'] }),
  });
  return { mutate: (id, enabled) => mut.mutateAsync({ id, enabled }), isPending: mut.isPending };
}

export function useLoginSite(): {
  mutate: (id: string) => Promise<{ status: 'pending'; login_id: string }>;
  isPending: boolean;
} {
  const qc = useQueryClient();
  const mut = useMutation<{ status: 'pending'; login_id: string }, Error, string>({
    mutationFn: (id) =>
      api<{ status: 'pending'; login_id: string }>(`/api/sites/${id}/login`, {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sites'] }),
  });
  return { mutate: (id) => mut.mutateAsync(id), isPending: mut.isPending };
}
