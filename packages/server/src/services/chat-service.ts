import type { Database as DatabaseType } from 'better-sqlite3';
import { ConflictError, createLogger, type ChatMessage } from '@vina/shared';
import {
  appendMessage,
  clearAll,
  listRecent,
} from '../db/repositories/chat-messages.js';
import { getOrInitSettings, updateSettings } from '../db/repositories/settings.js';
import type { EventBus } from '../events/bus.js';
import { createChatBridge, type ChatBridge, type ChatTurnOutcome } from '../opencode/chat-bridge.js';
import type { OpenCodeHost } from '../opencode/host.js';

const log = createLogger('chat-service');

/** Agent id for the single persistent conversation (docs/opencode-orchestration.md §5). */
const CHAT_AGENT = 'vina-chat';
/** Bound on tool rounds per turn (mirrors archived M20). */
const MAX_TOOL_ROUNDS = 8;
/** Default turn timeout before the session is interrupted. */
const TURN_TIMEOUT_MS = 120_000;

export interface ChatServiceDeps {
  host: OpenCodeHost;
  db: DatabaseType;
  bus: EventBus;
  /** Injectable for tests; defaults to `createChatBridge` against the host. */
  bridge?: ChatBridge;
  turnTimeoutMs?: number;
}

export interface ChatService {
  /** Persist + emit the user message, then drive the turn to completion. */
  startTurn(text: string): Promise<ChatMessage>;
  /** Drop the session, the persisted history, and the stored session id. */
  clearChat(): Promise<void>;
  /** True while a turn is in flight. */
  isTurnRunning(): boolean;
  /** Most-recent persisted messages, newest first. */
  history(limit?: number): ChatMessage[];
}

export function createChatService(deps: ChatServiceDeps): ChatService {
  const { host, db, bus } = deps;
  const bridge = deps.bridge ?? createChatBridge({ host, db, bus, maxToolRounds: MAX_TOOL_ROUNDS });
  const turnTimeoutMs = deps.turnTimeoutMs ?? TURN_TIMEOUT_MS;

  let turnInFlight = false;

  async function ensureSessionId(): Promise<string> {
    const settings = getOrInitSettings(db);
    if (settings.chat_session_id) {
      try {
        await host.client.session.get({ sessionID: settings.chat_session_id });
        return settings.chat_session_id;
      } catch {
        // Session was removed or its storage cleared — create a fresh one below.
        log.warn('stored chat session id no longer resolvable; creating a new session');
      }
    }
    const session = await host.client.session.create({ agent: CHAT_AGENT });
    updateSettings(db, { chat_session_id: session.id });
    return session.id;
  }

  function emitFriendlyFailure(reason: string): ChatMessage {
    const msg = appendMessage(db, {
      role: 'assistant',
      content:
        "Sorry — I couldn't finish that turn. Please try again, or check that your LLM provider is configured in Settings.",
      metadata: { error: 'turn_failed', reason },
    });
    bus.emit('chat:message', msg);
    return msg;
  }

  async function startTurn(text: string): Promise<ChatMessage> {
    if (turnInFlight) throw new ConflictError('A chat turn is already running');
    turnInFlight = true;

    try {
      const sessionId = await ensureSessionId();

      // Persist + stream the user message first so the UI shows it immediately.
      const userMsg = appendMessage(db, { role: 'user', content: text });
      bus.emit('chat:message', userMsg);

      // Subscribe before prompting so no delta is missed.
      const bridgeDone = bridge.run(sessionId);
      await host.client.session.prompt({ sessionID: sessionId, text });

      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<ChatTurnOutcome>((resolve) => {
        timeout = setTimeout(() => resolve({ reason: 'failed', error: 'turn_timeout' }), turnTimeoutMs);
      });

      const outcome = await Promise.race([bridgeDone, timeoutPromise]);
      if (timeout) clearTimeout(timeout);

      if (outcome.reason !== 'idle') {
        // Interrupt so the session never stays busy; the bridge already returned.
        try {
          await host.client.session.interrupt({ sessionID: sessionId });
        } catch {
          // already idle is fine
        }
        return emitFriendlyFailure(outcome.reason === 'failed' ? outcome.error : outcome.reason);
      }

      return userMsg;
    } finally {
      turnInFlight = false;
    }
  }

  async function clearChat(): Promise<void> {
    const settings = getOrInitSettings(db);
    if (settings.chat_session_id) {
      try {
        await host.client.session.remove({ sessionID: settings.chat_session_id });
      } catch {
        // already gone is fine
      }
      updateSettings(db, { chat_session_id: null });
    }
    clearAll(db);
  }

  return {
    startTurn,
    clearChat,
    isTurnRunning: () => turnInFlight,
    // listRecent returns newest-first; reverse so the UI renders chronologically.
    history: (limit = 100) => listRecent(db, limit).reverse(),
  };
}
