import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@vina/shared';
import { freshTestDb } from '../db/helpers.js';
import { createEventBus, type EventBus } from '../../src/events/bus.js';
import { createChatBridge } from '../../src/opencode/chat-bridge.js';
import type { OpenCodeHost } from '../../src/opencode/host.js';

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

function fakeHost(events: unknown[]): OpenCodeHost {
  return {
    client: {
      event: { subscribe: () => fromArray(events) },
      message: { list: async () => ({ data: [], cursor: {} }) },
    },
    close: async () => {},
  } as unknown as OpenCodeHost;
}

interface Captured {
  tokens: Array<{ message_id: string; token: string }>;
  messages: ChatMessage[];
}

function capture(bus: EventBus): Captured {
  const captured: Captured = { tokens: [], messages: [] };
  bus.on('chat:token', (p) => captured.tokens.push(p));
  bus.on('chat:message', (p) => captured.messages.push(p));
  return captured;
}

describe('chat bridge', () => {
  it('streams token deltas in order and finalizes the concatenated assistant message', async () => {
    const db = freshTestDb();
    const bus = createEventBus();
    const captured = capture(bus);

    const events = [
      { type: 'session.step.started', data: { sessionID: 's1', assistantMessageID: 'a1' } },
      {
        type: 'session.text.delta',
        data: { sessionID: 's1', assistantMessageID: 'a1', ordinal: 0, delta: 'Hel' },
      },
      {
        type: 'session.text.delta',
        data: { sessionID: 's1', assistantMessageID: 'a1', ordinal: 1, delta: 'lo' },
      },
      { type: 'session.step.ended', data: { sessionID: 's1', assistantMessageID: 'a1', finish: 'stop' } },
      { type: 'session.idle', data: { sessionID: 's1' } },
    ];

    const bridge = createChatBridge({ host: fakeHost(events), db, bus });
    const outcome = await bridge.run('s1');

    expect(outcome).toEqual({ reason: 'idle' });
    // message_id is the stable assistantMessageID across deltas + finalize.
    expect(captured.tokens).toEqual([
      { message_id: 'a1', token: 'Hel' },
      { message_id: 'a1', token: 'lo' },
    ]);
    expect(captured.messages).toHaveLength(1);
    const msg = captured.messages[0]!;
    expect(msg.id).toBe('a1');
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('Hello');
    db.close();
  });

  it('ignores events from other sessions', async () => {
    const db = freshTestDb();
    const bus = createEventBus();
    const captured = capture(bus);

    const events = [
      {
        type: 'session.text.delta',
        data: { sessionID: 'other', assistantMessageID: 'x', ordinal: 0, delta: 'no' },
      },
      { type: 'session.idle', data: { sessionID: 's1' } },
    ];

    const bridge = createChatBridge({ host: fakeHost(events), db, bus });
    await bridge.run('s1');
    expect(captured.tokens).toHaveLength(0);
    expect(captured.messages).toHaveLength(0);
    db.close();
  });

  it('persists tool rows with tool_call_id + metadata and stops at the round cap', async () => {
    const db = freshTestDb();
    const bus = createEventBus();
    const captured = capture(bus);

    const events: unknown[] = [];
    for (let i = 0; i < 8; i++) {
      events.push({
        type: 'session.tool.called',
        data: { sessionID: 's1', id: `t${i}`, input: { query: `q${i}` } },
      });
      events.push({
        type: 'session.tool.success',
        data: {
          sessionID: 's1',
          id: `t${i}`,
          content: [{ type: 'text', text: `out${i}` }],
        },
      });
    }

    const bridge = createChatBridge({
      host: fakeHost(events),
      db,
      bus,
      toolName: async () => 'vina_search_jobs',
    });
    const outcome = await bridge.run('s1');

    expect(outcome.reason).toBe('cap_exceeded');
    expect(outcome.toolRounds).toBe(8);
    expect(captured.messages).toHaveLength(8);
    const first = captured.messages[0]!;
    expect(first.role).toBe('tool');
    expect(first.tool_call_id).toBe('t0');
    expect(first.content).toBe('out0');
    expect(JSON.parse(first.metadata ?? '{}')).toEqual({
      tool_name: 'vina_search_jobs',
      args: { query: 'q0' },
      state: 'completed',
    });
    db.close();
  });

  it('persists a tool failure row with state error', async () => {
    const db = freshTestDb();
    const bus = createEventBus();
    const captured = capture(bus);

    const events = [
      { type: 'session.tool.called', data: { sessionID: 's1', id: 't9', input: {} } },
      {
        type: 'session.tool.failed',
        data: { sessionID: 's1', id: 't9', error: { message: 'boom' } },
      },
    ];

    const bridge = createChatBridge({
      host: fakeHost(events),
      db,
      bus,
      toolName: async () => 'vina_job_get',
    });
    await bridge.run('s1');

    expect(captured.messages).toHaveLength(1);
    const msg = captured.messages[0]!;
    expect(msg.role).toBe('tool');
    expect(msg.content).toBe('boom');
    expect(JSON.parse(msg.metadata ?? '{}').state).toBe('error');
    db.close();
  });

  it('surfaces a session execution failure', async () => {
    const db = freshTestDb();
    const bus = createEventBus();
    const events = [
      {
        type: 'session.execution.failed',
        data: { sessionID: 's1', error: { message: 'provider down' } },
      },
    ];
    const bridge = createChatBridge({ host: fakeHost(events), db, bus });
    const outcome = await bridge.run('s1');
    expect(outcome).toEqual({ reason: 'failed', error: 'provider down' });
    db.close();
  });
});
