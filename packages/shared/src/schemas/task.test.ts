import { describe, expect, it } from 'vitest';
import { TASK_KINDS } from '../enums.js';
import { TaskSchema } from './task.js';

describe('TaskSchema', () => {
  it('parses a prepare_manual_apply task', () => {
    const task = {
      id: '01HTASK',
      kind: 'prepare_manual_apply' as const,
      payload: '{"job_id":"01HJOB"}',
      priority: 0,
      attempts: 0,
      max_attempts: 3,
      next_attempt_at: '2026-04-28T10:00:00Z',
      started_at: null,
      failed_reason: null,
      status: 'pending' as const,
      created_at: '2026-04-28T10:00:00Z',
    };
    expect(TaskSchema.parse(task)).toEqual(task);
  });

  it('lists prepare_manual_apply among task kinds', () => {
    expect(TASK_KINDS).toContain('prepare_manual_apply');
  });

  it('rejects negative attempts', () => {
    expect(() =>
      TaskSchema.parse({
        id: '01HT',
        kind: 'apply',
        payload: '{}',
        priority: 0,
        attempts: -1,
        max_attempts: 3,
        next_attempt_at: '2026-04-28T10:00:00Z',
        started_at: null,
        failed_reason: null,
        status: 'pending',
        created_at: '2026-04-28T10:00:00Z',
      }),
    ).toThrow();
  });
});
