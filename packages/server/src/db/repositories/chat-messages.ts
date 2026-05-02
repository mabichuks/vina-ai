import type { Database as DatabaseType } from 'better-sqlite3';
import { newId, type ChatMessage, type ChatRole } from '@vina/shared';

interface ChatMessageRow {
  id: string;
  role: ChatRole;
  content: string;
  tool_call_id: string | null;
  metadata: string | null;
  created_at: string;
}

function rowToMessage(row: ChatMessageRow): ChatMessage {
  return row;
}

export interface AppendMessageInput {
  role: ChatRole;
  content: string;
  tool_call_id?: string | null;
  metadata?: unknown;
}

export function appendMessage(db: DatabaseType, input: AppendMessageInput): ChatMessage {
  const id = newId();
  const now = new Date().toISOString();
  const metadata =
    input.metadata === undefined || input.metadata === null
      ? null
      : typeof input.metadata === 'string'
        ? input.metadata
        : JSON.stringify(input.metadata);

  db.prepare(
    `INSERT INTO chat_messages (id, role, content, tool_call_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.role, input.content, input.tool_call_id ?? null, metadata, now);

  return {
    id,
    role: input.role,
    content: input.content,
    tool_call_id: input.tool_call_id ?? null,
    metadata,
    created_at: now,
  };
}

/**
 * Returns the most recent `limit` messages, newest first. If `beforeId` is
 * supplied, returns messages older than that row (cursor-style pagination).
 */
export function listRecent(db: DatabaseType, limit: number, beforeId?: string): ChatMessage[] {
  if (beforeId) {
    const cursor = db
      .prepare(`SELECT created_at, id FROM chat_messages WHERE id = ?`)
      .get(beforeId) as { created_at: string; id: string } | undefined;
    if (!cursor) return [];
    // Compound cursor on (created_at, id) keeps pagination stable when
    // multiple rows share a millisecond timestamp.
    const rows = db
      .prepare(
        `SELECT * FROM chat_messages
         WHERE (created_at, id) < (?, ?)
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(cursor.created_at, cursor.id, limit) as ChatMessageRow[];
    return rows.map(rowToMessage);
  }
  const rows = db
    .prepare(
      `SELECT * FROM chat_messages
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(limit) as ChatMessageRow[];
  return rows.map(rowToMessage);
}

export function clearAll(db: DatabaseType): void {
  db.prepare(`DELETE FROM chat_messages`).run();
}
