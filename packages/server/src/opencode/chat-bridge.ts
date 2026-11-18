import type { Database as DatabaseType } from 'better-sqlite3';
import { appendMessage } from '../db/repositories/chat-messages.js';
import type { EventBus } from '../events/bus.js';
import type { OpenCodeHost } from './host.js';

/**
 * Streaming bridge (issue #18). Subscribes to the host's SDK event stream for
 * one chat session and maps it onto the existing `chat:token` / `chat:message`
 * bus events, persisting every row to `chat_messages`.
 *
 * SDK 2.3.1 event → Vina event mapping (confirmed against the installed SDK;
 * the spike's assumed `message.part.updated` does not exist — text deltas are
 * `session.text.delta`):
 *
 * - `session.text.delta`      → `chat:token` `{ message_id, token }` where
 *   `message_id` is the stable `assistantMessageID`.
 * - `session.tool.called`     → record the tool input (no emit yet).
 * - `session.tool.success`/`session.tool.failed` → `chat:message` role `tool`
 *   with `tool_call_id` + `metadata { tool_name, args, state }`.
 * - `session.step.ended`      → finalize the assistant `chat:message` whose
 *   content equals the concatenated deltas for that `assistantMessageID`.
 * - `session.idle`            → turn complete.
 */

export interface ChatBridgeDeps {
  host: OpenCodeHost;
  db: DatabaseType;
  bus: EventBus;
  /** Resolve a tool name for a tool-call id; defaults to reading the assistant message parts. */
  toolName?: (toolCallId: string) => Promise<string | null>;
  /** Bound the agent loop; the run ends with `cap_exceeded` past this many tool rounds. */
  maxToolRounds?: number;
}

export type ChatTurnOutcome =
  | { reason: 'idle' }
  | { reason: 'cap_exceeded'; toolRounds: number }
  | { reason: 'failed'; error: string }
  | { reason: 'stream_ended' };

export interface ChatBridge {
  run(sessionId: string): Promise<ChatTurnOutcome>;
}

/** Flatten a `ToolContent` array to a single text string. */
function extractToolText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts = content
    .map((p) => {
      if (p && typeof p === 'object' && (p as { type?: string }).type === 'text') {
        return (p as { text?: string }).text ?? '';
      }
      return '';
    })
    .filter(Boolean);
  return parts.join('\n');
}

async function defaultToolName(
  host: OpenCodeHost,
  sessionId: string,
  toolCallId: string,
): Promise<string | null> {
  try {
    const res = await host.client.message.list({ sessionID: sessionId });
    for (const msg of res.data) {
      if (msg.type !== 'assistant') continue;
      for (const part of msg.content) {
        if (part.type === 'tool' && part.id === toolCallId) return part.name;
      }
    }
  } catch {
    // best-effort: tool name is cosmetic for the result card
  }
  return null;
}

export function createChatBridge(deps: ChatBridgeDeps): ChatBridge {
  const maxToolRounds = deps.maxToolRounds ?? 8;

  async function run(sessionId: string): Promise<ChatTurnOutcome> {
    const textByMessage = new Map<string, string>();
    const toolArgs = new Map<string, unknown>();
    let toolRounds = 0;

    for await (const event of deps.host.client.event.subscribe()) {
      const data = (event as { data?: { sessionID?: string } }).data;
      if (!data || data.sessionID !== sessionId) continue;

      switch (event.type) {
        case 'session.text.delta': {
          const d = (event as unknown as { data: { assistantMessageID: string; delta: string } })
            .data;
          const prev = textByMessage.get(d.assistantMessageID) ?? '';
          textByMessage.set(d.assistantMessageID, prev + d.delta);
          deps.bus.emit('chat:token', { message_id: d.assistantMessageID, token: d.delta });
          break;
        }

        case 'session.tool.called': {
          const d = (event as unknown as { data: { id: string; input: unknown } }).data;
          toolArgs.set(d.id, d.input);
          break;
        }

        case 'session.tool.success': {
          const d = (event as unknown as {
            data: { id: string; content: unknown };
          }).data;
          toolRounds += 1;
          const name = deps.toolName
            ? await deps.toolName(d.id)
            : await defaultToolName(deps.host, sessionId, d.id);
          const msg = appendMessage(deps.db, {
            id: d.id,
            role: 'tool',
            content: extractToolText(d.content),
            tool_call_id: d.id,
            metadata: { tool_name: name, args: toolArgs.get(d.id) ?? null, state: 'completed' },
          });
          deps.bus.emit('chat:message', msg);
          if (toolRounds >= maxToolRounds) return { reason: 'cap_exceeded', toolRounds };
          break;
        }

        case 'session.tool.failed': {
          const d = (event as unknown as {
            data: { id: string; error: { message: string } };
          }).data;
          toolRounds += 1;
          const name = deps.toolName
            ? await deps.toolName(d.id)
            : await defaultToolName(deps.host, sessionId, d.id);
          const msg = appendMessage(deps.db, {
            id: d.id,
            role: 'tool',
            content: d.error.message,
            tool_call_id: d.id,
            metadata: { tool_name: name, args: toolArgs.get(d.id) ?? null, state: 'error' },
          });
          deps.bus.emit('chat:message', msg);
          if (toolRounds >= maxToolRounds) return { reason: 'cap_exceeded', toolRounds };
          break;
        }

        case 'session.step.ended': {
          const d = (event as unknown as { data: { assistantMessageID: string } }).data;
          const text = textByMessage.get(d.assistantMessageID);
          if (text && text.length > 0) {
            const msg = appendMessage(deps.db, {
              id: d.assistantMessageID,
              role: 'assistant',
              content: text,
            });
            deps.bus.emit('chat:message', msg);
          }
          break;
        }

        case 'session.execution.failed': {
          const d = (event as unknown as { data: { error: { message: string } } }).data;
          return { reason: 'failed', error: d.error.message };
        }

        case 'session.idle':
          return { reason: 'idle' };
      }
    }

    return { reason: 'stream_ended' };
  }

  return { run };
}
