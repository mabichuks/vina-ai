import { z } from 'zod';
import { CHAT_ROLES } from '../enums.js';

const isoDate = z.iso.datetime();

export const ChatMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(CHAT_ROLES),
  content: z.string(),
  tool_call_id: z.string().nullable(),
  metadata: z.string().nullable(),
  created_at: isoDate,
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
