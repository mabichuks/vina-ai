import { describe, expect, it } from 'vitest';
import { ALERT_KINDS } from '../enums.js';
import { AlertSchema } from './alert.js';

describe('AlertSchema', () => {
  it('parses a ready_for_manual_apply alert', () => {
    const alert = {
      id: '01HALERT',
      kind: 'ready_for_manual_apply' as const,
      severity: 'action_required' as const,
      title: 'Ready to apply',
      description: 'Tailored CV is ready. Open the listing to submit.',
      application_id: '01HAPP',
      site_id: 'google',
      payload: '{"external_apply_url":"https://x"}',
      status: 'open' as const,
      resolution_value: null,
      created_at: '2026-04-28T10:00:00Z',
      resolved_at: null,
    };
    expect(AlertSchema.parse(alert)).toEqual(alert);
  });

  it('lists ready_for_manual_apply among the kinds', () => {
    expect(ALERT_KINDS).toContain('ready_for_manual_apply');
  });

  it('rejects unknown severity', () => {
    expect(() =>
      AlertSchema.parse({
        id: '01HA',
        kind: 'general',
        severity: 'critical',
        title: 'x',
        description: '',
        application_id: null,
        site_id: null,
        payload: null,
        status: 'open',
        resolution_value: null,
        created_at: '2026-04-28T10:00:00Z',
        resolved_at: null,
      }),
    ).toThrow();
  });
});
