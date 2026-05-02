import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { createLogger, EVENTS, type EventName } from '@vina/shared';
import type { ServerConfig } from '../config.js';
import type { EventBus } from '../events/bus.js';

const log = createLogger('ws');

/**
 * WebSocket gateway. Authenticates clients via the bearer token in the
 * connect URL, holds the open sockets in a Set, subscribes once per shared
 * `EventName` to the in-process bus, and fans each emitted event out to
 * every connected client as `{ type, payload, timestamp }`.
 */
export async function registerWebSocket(
  app: FastifyInstance,
  config: ServerConfig,
  bus: EventBus,
): Promise<void> {
  await app.register(websocket);

  // Track connected sockets so bus events can fan out. The Set is scoped
  // to this registration call (one per app); do not move to module scope
  // or restarts will leak references. `@fastify/websocket` doesn't export
  // the socket type, so we use a structural duck-type that names only the
  // pieces we touch — TS still verifies the route handler's `socket`
  // parameter satisfies it at the `sockets.add(socket)` call below.
  interface WsLike {
    readonly readyState: number;
    readonly OPEN: number;
    send(data: string): void;
    close(code: number, reason: string): void;
    on(event: 'message' | 'close', handler: (data: Buffer) => void): void;
  }
  const sockets = new Set<WsLike>();

  // Subscribe once per event name. These subscribers stay alive for the
  // lifetime of the app — the bus is owned by main.ts and torn down when
  // the daemon shuts down.
  for (const name of Object.values(EVENTS) as EventName[]) {
    bus.on(name, (payload) => {
      const envelope = JSON.stringify({
        type: name,
        payload,
        timestamp: new Date().toISOString(),
      });
      for (const socket of sockets) {
        if (socket.readyState === socket.OPEN) socket.send(envelope);
      }
    });
  }

  app.get('/ws', { websocket: true }, (socket, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    if (token !== config.bearerToken) {
      socket.close(4401, 'unauthorized');
      return;
    }

    sockets.add(socket);
    log.debug({ ip: req.ip }, 'ws client connected');

    socket.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as { type?: unknown };
        if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
      } catch {
        // ignore malformed frames
      }
    });

    socket.on('close', () => {
      sockets.delete(socket);
      log.debug('ws client disconnected');
    });
  });
}
