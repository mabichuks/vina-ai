import { describe, expect, it } from 'vitest';
import { nextRunAt } from '../../src/scheduler/cron.js';

describe('nextRunAt', () => {
  it('returns the next ISO timestamp after the reference time', () => {
    const ref = new Date('2026-05-02T10:00:00Z');
    // every day at 12:00 (local interpretation by cron-parser)
    const next = nextRunAt('0 12 * * *', ref);

    // Should be a valid ISO string
    expect(next).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // Should be after the reference time
    const nextDate = new Date(next);
    expect(nextDate.getTime()).toBeGreaterThan(ref.getTime());
  });

  it('throws on a syntactically invalid expression', () => {
    expect(() => nextRunAt('not a cron', new Date())).toThrow();
  });
});
