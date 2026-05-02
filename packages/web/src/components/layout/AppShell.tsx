import { Outlet } from 'react-router-dom';
import { useAuthStore } from '../../store/auth-store.js';
import { useUiStore } from '../../store/ui-store.js';
import { useWebSocket } from '../../api/ws.js';
import { Sidebar } from './Sidebar.js';
import { Topbar } from './Topbar.js';

export function AppShell(): JSX.Element {
  const token = useAuthStore((s) => s.token);
  const wsDisconnected = useUiStore((s) => s.wsDisconnected);
  useWebSocket(token);

  return (
    <div className="flex h-screen w-screen bg-surface-base text-ink-primary">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <Topbar />
        {wsDisconnected && (
          <div className="bg-danger-soft px-4 py-1.5 text-xs text-danger">
            Disconnected from the Vina daemon — attempting to reconnect…
          </div>
        )}
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
