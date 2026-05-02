import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark';

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

interface UiState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;

  sidebarCollapsed: boolean;
  toggleSidebar: () => void;

  toasts: Toast[];
  pushToast: (toast: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;

  /** True for the lifetime of the tab once the user closes the Finish-setup pill. */
  finishSetupDismissed: boolean;
  dismissFinishSetup: () => void;

  /** WS connection: surfaces a banner after the threshold elapses. */
  wsDisconnected: boolean;
  setWsDisconnected: (v: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: 'light',
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set((state) => ({ theme: state.theme === 'light' ? 'dark' : 'light' })),

      sidebarCollapsed: false,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

      toasts: [],
      pushToast: (toast) =>
        set((s) => ({
          toasts: [...s.toasts, { ...toast, id: crypto.randomUUID() }],
        })),
      dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

      finishSetupDismissed: false,
      dismissFinishSetup: () => set({ finishSetupDismissed: true }),

      wsDisconnected: false,
      setWsDisconnected: (v) => set({ wsDisconnected: v }),
    }),
    {
      name: 'vina-ui',
      // Only persist user preferences. Toasts, ws state, and dismissal flags
      // are session-scoped — surviving reloads would feel stale.
      partialize: (state) => ({
        theme: state.theme,
        sidebarCollapsed: state.sidebarCollapsed,
      }),
    },
  ),
);
