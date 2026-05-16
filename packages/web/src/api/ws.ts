import { useEffect, useRef } from 'react';
import { useUiStore } from '../store/ui-store.js';
import { queryClient } from '../store/query-client.js';
import { useSearchProgressStore } from '../store/search-progress-store.js';

type Handler = (payload: unknown) => void;

const DISCONNECTED_BANNER_AFTER_MS = 5_000;

interface WebSocketEnvelope {
  type: string;
  payload: unknown;
}

/**
 * Map of WS event types → query keys that should refetch when the event
 * arrives. Centralised here so the dispatcher stays simple and so we can see
 * the live-update wiring for the whole app in one place.
 */
const INVALIDATIONS: Record<string, ReadonlyArray<readonly unknown[]>> = {
  'jobs:updated': [['jobs']],
  'search:started': [['jobs']],
  'search:completed': [['jobs']],
  'search:failed': [['jobs']],
  'search:cancelled': [['jobs']],
  'linkedin:session-expired': [['linkedin-status']],
  'site:login_status': [['sites'], ['linkedin-status']],
  'alert:created': [['alerts']],
  'alert:resolved': [['alerts']],
  'alert:dismissed': [['alerts']],
};

function invalidateQueriesFor(eventType: string): void {
  const keys = INVALIDATIONS[eventType];
  if (!keys) return;
  for (const key of keys) {
    void queryClient.invalidateQueries({ queryKey: [...key] });
  }
}

interface JobsUpdatedPayload {
  ids: string[];
}
interface SearchCompletedPayload {
  scored: number;
}
interface SearchFailedPayload {
  error_kind: string;
}

/**
 * Route lifecycle events to the search-progress store so phase-aware UI
 * (search-now button, Dashboard activity panel) stays in sync without each
 * component subscribing to the WS hub directly.
 */
function updateSearchProgressFor(eventType: string, payload: unknown): void {
  const store = useSearchProgressStore.getState();
  switch (eventType) {
    case 'search:started': {
      const taskId = (payload as { task_id?: string } | undefined)?.task_id;
      store.beginDiscovering({ taskId });
      break;
    }
    case 'search:cancelled':
      store.markCancelled();
      break;
    case 'jobs:updated': {
      // Discovery progress only. Score completions emit a dedicated
      // score:job_completed event — counting jobs:updated during 'scoring'
      // would race with manual triage events (skip/applied) and miscount.
      if (store.phase !== 'discovering') return;
      const ids = (payload as JobsUpdatedPayload | undefined)?.ids;
      const n = Array.isArray(ids) ? ids.length : 0;
      if (n === 0) return;
      store.countDiscoveredListings(n);
      break;
    }
    case 'score:job_completed': {
      // Always count one toward the scoring goal, regardless of which phase
      // we're observing. A score task that completes before search:completed
      // still represents real progress; we just buffer it until beginScoring
      // sets the target.
      if (store.phase === 'scoring') store.countScored(1);
      break;
    }
    case 'search:completed': {
      const scored = (payload as SearchCompletedPayload | undefined)?.scored ?? 0;
      store.beginScoring(scored);
      break;
    }
    case 'search:failed': {
      const errorKind = (payload as SearchFailedPayload | undefined)?.error_kind ?? 'unknown';
      store.markError(errorKind);
      break;
    }
  }
}

interface UseWebSocketController {
  subscribe: (event: string, handler: Handler) => () => void;
}

/**
 * Maintains a single WebSocket connection per token. Reconnects with capped
 * exponential backoff and surfaces a "disconnected" banner via `ui-store`
 * once the connection has been down for `DISCONNECTED_BANNER_AFTER_MS`.
 *
 * Only the React tree wires this up once (in `<App />`); `subscribe` lets
 * other components listen for specific event names.
 */
export function useWebSocket(token: string | null): UseWebSocketController {
  const handlers = useRef(new Map<string, Set<Handler>>());
  const sock = useRef<WebSocket | null>(null);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeat = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!token) return undefined;

    const setDisconnected = useUiStore.getState().setWsDisconnected;

    const cleanupTimers = (): void => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (disconnectTimer.current) clearTimeout(disconnectTimer.current);
      if (heartbeat.current) clearInterval(heartbeat.current);
      reconnectTimer.current = null;
      disconnectTimer.current = null;
      heartbeat.current = null;
    };

    const connect = (): void => {
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${
        location.host
      }/ws?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      sock.current = ws;

      ws.addEventListener('open', () => {
        reconnectAttempt.current = 0;
        if (disconnectTimer.current) clearTimeout(disconnectTimer.current);
        setDisconnected(false);

        heartbeat.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 30_000);
      });

      ws.addEventListener('message', (ev: MessageEvent<string>) => {
        let envelope: WebSocketEnvelope;
        try {
          envelope = JSON.parse(ev.data) as WebSocketEnvelope;
        } catch {
          return;
        }
        if (!envelope.type) return;
        invalidateQueriesFor(envelope.type);
        updateSearchProgressFor(envelope.type, envelope.payload);
        const set = handlers.current.get(envelope.type);
        if (set) {
          for (const h of set) h(envelope.payload);
        }
      });

      ws.addEventListener('close', (ev) => {
        if (heartbeat.current) clearInterval(heartbeat.current);
        // 4401 means the server rejected our token — don't loop forever.
        if (ev.code === 4401) return;

        if (!disconnectTimer.current) {
          disconnectTimer.current = setTimeout(() => {
            setDisconnected(true);
          }, DISCONNECTED_BANNER_AFTER_MS);
        }

        const attempt = reconnectAttempt.current;
        reconnectAttempt.current = attempt + 1;
        const delay = Math.min(1_000 * 2 ** attempt, 30_000);
        // The effect tears down on token change, so this closure's `token`
        // is always the live one — no need for a ref.
        reconnectTimer.current = setTimeout(connect, delay);
      });
    };

    connect();
    return () => {
      cleanupTimers();
      sock.current?.close();
      sock.current = null;
      setDisconnected(false);
    };
  }, [token]);

  return {
    subscribe: (event, handler) => {
      const set = handlers.current.get(event) ?? new Set<Handler>();
      set.add(handler);
      handlers.current.set(event, set);
      return () => {
        set.delete(handler);
      };
    },
  };
}
