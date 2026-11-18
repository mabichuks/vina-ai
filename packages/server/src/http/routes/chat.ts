import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../parse.js';
import type { ChatService } from '../../services/chat-service.js';

const SendMessageSchema = z.object({ text: z.string().min(1) });
const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/**
 * Chat REST surface (issue #18). Streaming arrives over the existing
 * `chat:token`/`chat:message` WebSocket events; this route only covers the
 * request/response and history/clear operations.
 */
export async function chatRoutes(
  app: FastifyInstance,
  deps: { chat: ChatService },
): Promise<void> {
  const { chat } = deps;

  app.get('/api/chat/messages', async (req) => {
    const q = parse(ListQuerySchema, req.query, 'query');
    return { items: chat.history(q.limit) };
  });

  app.post('/api/chat/messages', async (req) => {
    const { text } = parse(SendMessageSchema, req.body);
    // The user message is streamed back over the WS bus; return the persisted
    // row so the UI can seed its optimistic view while tokens stream.
    return chat.startTurn(text);
  });

  app.delete('/api/chat/messages', async (_req, reply) => {
    await chat.clearChat();
    return reply.status(204).send();
  });
}
