import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '../../src/store/chat-store.js';
import type { ChatMessage } from '@vina/shared';

function msg(id: string, content: string, role: ChatMessage['role'] = 'assistant'): ChatMessage {
  return {
    id,
    role,
    content,
    tool_call_id: null,
    metadata: null,
    created_at: '2026-04-01T00:00:00Z',
  };
}

describe('chat store', () => {
  beforeEach(() => {
    useChatStore.getState().clear();
  });

  it('accumulates tokens then finalizes into a single message (M20 parity)', () => {
    const store = useChatStore.getState();
    store.onToken('a1', 'Hel');
    store.onToken('a1', 'lo');
    expect(useChatStore.getState().streaming).toEqual({ a1: 'Hello' });
    expect(useChatStore.getState().messages).toHaveLength(0);

    store.onMessage(msg('a1', 'Hello'));
    const state = useChatStore.getState();
    expect(state.streaming).toEqual({});
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.content).toBe('Hello');
  });

  it('appends user and tool messages verbatim', () => {
    const store = useChatStore.getState();
    store.onMessage(msg('u1', 'hi', 'user'));
    store.onMessage(msg('t1', 'out', 'tool'));
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['u1', 't1']);
  });

  it('hydrates history and resets on clear', () => {
    useChatStore.getState().hydrate([msg('m1', 'a'), msg('m2', 'b', 'user')]);
    expect(useChatStore.getState().hydrated).toBe(true);
    expect(useChatStore.getState().messages).toHaveLength(2);

    useChatStore.getState().clear();
    expect(useChatStore.getState().messages).toHaveLength(0);
    expect(useChatStore.getState().hydrated).toBe(false);
  });

  it('tracks the turn-running flag', () => {
    useChatStore.getState().setTurnRunning(true);
    expect(useChatStore.getState().turnRunning).toBe(true);
    useChatStore.getState().setTurnRunning(false);
    expect(useChatStore.getState().turnRunning).toBe(false);
  });
});
