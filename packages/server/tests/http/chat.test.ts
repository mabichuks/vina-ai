import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@vina/shared';
import type { ChatService } from '../../src/services/chat-service.js';
import { auth, buildTestApp, type TestAppHandle } from './helpers.js';

function makeFakeChat(): ChatService {
  const rows: ChatMessage[] = [
    {
      id: 'm1',
      role: 'user',
      content: 'hi',
      tool_call_id: null,
      metadata: null,
      created_at: '2026-04-01T00:00:00Z',
    },
  ];
  return {
    startTurn: vi.fn(async (text: string): Promise<ChatMessage> => ({
      id: 'm2',
      role: 'user',
      content: text,
      tool_call_id: null,
      metadata: null,
      created_at: '2026-04-01T00:00:01Z',
    })),
    clearChat: vi.fn(async () => undefined),
    isTurnRunning: () => false,
    history: () => rows,
  };
}

let h: TestAppHandle;
let chat: ChatService;
beforeEach(async () => {
  chat = makeFakeChat();
  h = await buildTestApp({ chat });
});
afterEach(async () => {
  await h.cleanup();
});

describe('chat routes', () => {
  it('GET /api/chat/messages returns persisted history', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/chat/messages',
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0].content).toBe('hi');
  });

  it('POST /api/chat/messages starts a turn and returns the user message', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: auth(h.token),
      payload: { text: 'what jobs do I have?' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().content).toBe('what jobs do I have?');
    expect(chat.startTurn).toHaveBeenCalledWith('what jobs do I have?');
  });

  it('POST /api/chat/messages rejects empty text', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/chat/messages',
      headers: auth(h.token),
      payload: { text: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('DELETE /api/chat/messages clears the conversation', async () => {
    const res = await h.app.inject({
      method: 'DELETE',
      url: '/api/chat/messages',
      headers: auth(h.token),
    });
    expect(res.statusCode).toBe(204);
    expect(chat.clearChat).toHaveBeenCalledOnce();
  });
});
