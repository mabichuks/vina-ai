import type { FastifyInstance } from 'fastify';
import { createLogger } from '@vina/shared';
import type { ServerConfig } from '../config.js';

const log = createLogger('ws');

/**
 * Minimal WebSocket gateway for the frontend's `useWebSocket` hook.
 *
 * Phase 7 only needs the connection to authenticate and stay open;
 * actual server-pushed events (jobs:updated, alerts:created, etc.) get
 * wired in alongside the features that emit them in later phases.
 */
export async function registerWebSocket(app: FastifyInstance, config: ServerConfig): Promise<void> {
  // Lazy import so the websocket dep stays optional at type-check time.
  const websocket = (await import('@fastify/websocket')).default;
  await app.register(websocket);

  app.get('/ws', { websocket: true }, (socket, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    if (token !== config.bearerToken) {
      socket.close(4401, 'unauthorized');
      return;
    }

    log.debug({ ip: req.ip }, 'ws client connected');

    socket.on('message', (data: Buffer) => {
      // The protocol only expects `{ type: 'ping' }` heartbeats from the client
      // (per api-spec.md). Anything else is ignored.
      try {
        const msg = JSON.parse(data.toString()) as { type?: unknown };
        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        // ignore malformed frames
      }
    });

    socket.on('close', () => {
      log.debug('ws client disconnected');
    });
  });
}
