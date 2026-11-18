import { create } from 'zustand';
import type { ChatMessage } from '@vina/shared';

/**
 * Chat UX state (issue #18). Holds the persisted transcript plus in-flight
 * token buffers. The WebSocket dispatcher in `api/ws.ts` feeds `chat:token`
 * and `chat:message` events here; the Chat page reads both.
 *
 * Semantics mirror the M20 "accumulate-then-finalize" model: `onToken` appends
 * deltas to `streaming[message_id]`; the finalized `chat:message` (same
 * `message_id`) replaces the buffer with a full row in `messages`.
 */

export interface ChatState {
  /** Persisted rows, newest last. */
  messages: ChatMessage[];
  /** In-flight assistant text keyed by message id, cleared on finalize. */
  streaming: Record<string, string>;
  turnRunning: boolean;
  /** True once history has been fetched from the server. */
  hydrated: boolean;

  hydrate: (messages: ChatMessage[]) => void;
  onToken: (messageId: string, token: string) => void;
  onMessage: (message: ChatMessage) => void;
  setTurnRunning: (v: boolean) => void;
  clear: () => void;
}

const INITIAL = {
  messages: [] as ChatMessage[],
  streaming: {} as Record<string, string>,
  turnRunning: false,
  hydrated: false,
};

export const useChatStore = create<ChatState>((set) => ({
  ...INITIAL,

  hydrate: (messages) => set({ messages, hydrated: true }),

  onToken: (messageId, token) =>
    set((s) => ({
      streaming: { ...s.streaming, [messageId]: (s.streaming[messageId] ?? '') + token },
    })),

  onMessage: (message) =>
    set((s) => {
      // A finalized assistant message replaces any in-flight buffer for the
      // same id; everything else (user/tool rows) is appended verbatim.
      const streaming = { ...s.streaming };
      delete streaming[message.id];
      return {
        messages: [...s.messages, message],
        streaming,
      };
    }),

  setTurnRunning: (turnRunning) => set({ turnRunning }),

  clear: () => set({ ...INITIAL }),
}));
