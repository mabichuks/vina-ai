import { describe, expect, it } from 'vitest';
import { ChatMessageSchema } from './chat.js';

describe('ChatMessageSchema', () => {
  it.each([
    ['user', 'Hi Vina, anything new?'],
    ['assistant', 'You have 3 ready-to-apply roles.'],
    ['tool', '{"alerts":[]}'],
    ['system', 'Operating in autonomous mode.'],
  ] as const)('parses a %s message', (role, content) => {
    const msg = {
      id: `01HMSG-${role}`,
      role,
      content,
      tool_call_id: role === 'tool' ? 'call_1' : null,
      metadata: null,
      created_at: '2026-04-28T10:00:00Z',
    };
    expect(ChatMessageSchema.parse(msg)).toEqual(msg);
  });

  it('rejects unknown role', () => {
    expect(() =>
      ChatMessageSchema.parse({
        id: '01H',
        role: 'agent',
        content: 'x',
        tool_call_id: null,
        metadata: null,
        created_at: '2026-04-28T10:00:00Z',
      }),
    ).toThrow();
  });
});
