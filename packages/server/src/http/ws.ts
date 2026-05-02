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

  // Track connected sockets so bus events can fan out. The Set is module-
  // scoped to this registration call (one per app); do not move to module
  // scope or restarts will leak references.
  // reason: @fastify/websocket doesn't export the socket type; we infer it
  // from the route handler parameter type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sockets = new Set<any>();

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
