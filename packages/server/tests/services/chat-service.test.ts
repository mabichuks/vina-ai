import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@vina/shared';
import { freshTestDb } from '../db/helpers.js';
import { createEventBus } from '../../src/events/bus.js';
import { createChatService } from '../../src/services/chat-service.js';
import { getOrInitSettings } from '../../src/db/repositories/settings.js';
import { listRecent } from '../../src/db/repositories/chat-messages.js';
import type { OpenCodeHost } from '../../src/opencode/host.js';
import type { ChatBridge } from '../../src/opencode/chat-bridge.js';

interface FakeSession {
  id: string;
}

function makeFakeHost(): {
  host: OpenCodeHost;
  calls: { create: number; get: number; prompt: number; remove: number; interrupt: number };
  sessions: Map<string, FakeSession>;
} {
  const calls = { create: 0, get: 0, prompt: 0, remove: 0, interrupt: 0 };
  const createdAgents: string[] = [];
  const sessions = new Map<string, FakeSession>();
  const host = {
    client: {
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          calls.get += 1;
          const s = sessions.get(sessionID);
          if (!s) throw new Error('session not found');
          return s;
        },
        create: async ({ agent }: { agent: string }) => {
          calls.create += 1;
          createdAgents.push(agent);
          const id = `ses_${calls.create}`;
          sessions.set(id, { id });
          return { id, agent };
        },        prompt: async ({ sessionID, text }: { sessionID: string; text: string }) => {
          calls.prompt += 1;
          return { id: 'msg', sessionID, text, type: 'user' };
        },
        remove: async ({ sessionID }: { sessionID: string }) => {
          calls.remove += 1;
          sessions.delete(sessionID);
        },
        interrupt: async ({ sessionID }: { sessionID: string }) => {
          calls.interrupt += 1;
          return { interrupted: true, sessionID };
        },
      },
    },
    close: async () => {},
  } as unknown as OpenCodeHost;
  return { host, calls, createdAgents, sessions };
}

function idleBridge(): ChatBridge {
  return { run: async () => ({ reason: 'idle' }) };
}

describe('chat service', () => {
  it('creates a session on first turn and persists chat_session_id', async () => {
    const db = freshTestDb();
    const bus = createEventBus();
    const { host, calls, createdAgents } = makeFakeHost();
    const messages: ChatMessage[] = [];
    bus.on('chat:message', (m) => messages.push(m));

    const chat = createChatService({ host, db, bus, bridge: idleBridge() });
    await chat.startTurn('hello');

    expect(calls.create).toBe(1);
    expect(calls.prompt).toBe(1);
    // The chat path must run under the `vina-chat` agent so its deny boundary
    // (no submit, no browser) applies — the chat surface can never reach submit.
    expect(createdAgents).toEqual(['vina-chat']);
    const settings = getOrInitSettings(db);
    expect(settings.chat_session_id).toBe('ses_1');
    expect(listRecent(db, 10)).toHaveLength(1);
    expect(listRecent(db, 10)[0]?.role).toBe('user');
    expect(messages).toHaveLength(1);
    db.close();
  });

  it('resumes the stored session id instead of creating a new one', async () => {
    const db = freshTestDb();
    const bus = createEventBus();
    const { host, calls } = makeFakeHost();

    const chat = createChatService({ host, db, bus, bridge: idleBridge() });
    await chat.startTurn('first');
    await chat.startTurn('second');

    expect(calls.create).toBe(1);
    // Second turn resumed via get, not create.
    expect(calls.get).toBe(1);
    expect(calls.prompt).toBe(2);
    expect(getOrInitSettings(db).chat_session_id).toBe('ses_1');
    db.close();
  });

  it('clear removes the session, clears history, and nulls the stored id', async () => {
    const db = freshTestDb();
    const bus = createEventBus();
    const { host, calls } = makeFakeHost();

    const chat = createChatService({ host, db, bus, bridge: idleBridge() });
    await chat.startTurn('hello');
    await chat.clearChat();

    expect(calls.remove).toBe(1);
    expect(getOrInitSettings(db).chat_session_id).toBeNull();
    expect(listRecent(db, 10)).toHaveLength(0);
    db.close();
  });

  it('emits a friendly failure message and resets the turn flag on error', async () => {
    const db = freshTestDb();
    const bus = createEventBus();
    const { host, calls } = makeFakeHost();
    const messages: ChatMessage[] = [];
    bus.on('chat:message', (m) => messages.push(m));

    const failingBridge: ChatBridge = {
      run: async () => ({ reason: 'failed', error: 'provider down' }),
    };
    const chat = createChatService({ host, db, bus, bridge: failingBridge });
    await chat.startTurn('hello');

    expect(calls.interrupt).toBe(1);
    expect(chat.isTurnRunning()).toBe(false);
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(JSON.parse(assistant!.metadata ?? '{}')).toMatchObject({
      error: 'turn_failed',
      reason: 'provider down',
    });
    db.close();
  });

  it('rejects a concurrent turn', async () => {
    const db = freshTestDb();
    const bus = createEventBus();
    const { host } = makeFakeHost();

    const slowBridge: ChatBridge = {
      run: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { reason: 'idle' };
      },
    };
    const chat = createChatService({ host, db, bus, bridge: slowBridge });
    const first = chat.startTurn('one');
    await expect(chat.startTurn('two')).rejects.toThrow(/already running/);
    await first;
    db.close();
  });
});
