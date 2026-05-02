import { useEffect, useRef } from 'react';
import { useUiStore } from '../store/ui-store.js';

type Handler = (payload: unknown) => void;

const DISCONNECTED_BANNER_AFTER_MS = 5_000;

interface WebSocketEnvelope {
  type: string;
  payload: unknown;
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
