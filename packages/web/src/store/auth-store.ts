import { create } from 'zustand';

interface AuthState {
  token: string | null;
  setToken: (token: string | null) => void;
}

/**
 * Bearer token store. In-memory only — never persisted to localStorage,
 * since tokens are per-process and we always re-fetch via `/api/bootstrap`.
 */
export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  setToken: (token) => set({ token }),
}));

/** Non-React access — used by the API client outside hook contexts. */
export const getToken = (): string | null => useAuthStore.getState().token;
