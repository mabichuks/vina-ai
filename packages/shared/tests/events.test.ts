import { describe, expect, expectTypeOf, it } from 'vitest';
import { EVENT_PAYLOADS, EVENTS, type EventPayloadFor } from '../src/events.js';

describe('events catalog', () => {
  it('includes the manual-apply lifecycle events and a payload schema for every name', () => {
    const names = Object.values(EVENTS);
    expect(names).toContain('application:ready_for_manual_apply');
    expect(names).toContain('application:applied_manually');
    for (const name of names) expect(EVENT_PAYLOADS[name]).toBeDefined();
  });

  it('EventPayloadFor resolves to the correct payload shape', () => {
    type ReadyPayload = EventPayloadFor<typeof EVENTS.APPLICATION_READY_FOR_MANUAL_APPLY>;
    expectTypeOf<ReadyPayload>().toMatchTypeOf<{
      application_id: string;
      external_apply_url: string;
      tailored_cv_path: string;
    }>();
  });

  it('round-trips a representative payload per event', () => {
    const fixtures = [
      [EVENTS.JOBS_UPDATED, { ids: ['01J'] }],
      [EVENTS.APPLICATION_UPDATED, { id: '01A', status: 'submitted' }],
      [
        EVENTS.APPLICATION_READY_FOR_MANUAL_APPLY,
        {
          application_id: '01A',
          job_id: '01J',
          external_apply_url: 'https://x.greenhouse.io/jobs/1',
          tailored_cv_path: 't.docx',
          tailored_cover_letter_path: null,
        },
      ],
      [
        EVENTS.APPLICATION_APPLIED_MANUALLY,
        { application_id: '01A', applied_at: '2026-04-29T10:00:00Z' },
      ],
      [EVENTS.QUEUE_UPDATED, { pending: 3, running: 1 }],
    ] as const;
    for (const [name, payload] of fixtures) {
      expect(EVENT_PAYLOADS[name].parse(payload)).toEqual(payload);
    }
  });
});

describe('EVENTS — linkedin slice additions', () => {
  it.each(['SEARCH_STARTED', 'SEARCH_COMPLETED', 'SEARCH_FAILED', 'LINKEDIN_SESSION_EXPIRED'])(
    'includes %s',
    (key) => {
      expect((EVENTS as Record<string, string>)[key]).toBeTruthy();
    },
  );

  it('search:completed payload validates listings_added and scored', () => {
    const schema = EVENT_PAYLOADS['search:completed'];
    expect(() =>
      schema.parse({
        task_id: 't1',
        site_id: 'linkedin',
        listings_added: 3,
        scored: 2,
      }),
    ).not.toThrow();
  });

  it('search:failed payload validates the error_kind enum', () => {
    const schema = EVENT_PAYLOADS['search:failed'];
    expect(() =>
      schema.parse({ task_id: 't1', site_id: 'linkedin', error_kind: 'session_expired' }),
    ).not.toThrow();
    expect(() =>
      schema.parse({ task_id: 't1', site_id: 'linkedin', error_kind: 'bogus' }),
    ).toThrow();
  });

  it('linkedin:session-expired payload validates an ISO timestamp', () => {
    const schema = EVENT_PAYLOADS['linkedin:session-expired'];
    expect(() => schema.parse({ at: '2026-05-09T12:00:00.000Z' })).not.toThrow();
  });
});

describe('EVENTS — manual-apply slice additions', () => {
  it('declares application:skipped', () => {
    expect((EVENTS as Record<string, string>)['APPLICATION_SKIPPED']).toBe('application:skipped');
  });

  it('application:skipped payload accepts an optional reason', () => {
    const schema = EVENT_PAYLOADS['application:skipped'];
    expect(() =>
      schema.parse({ application_id: 'a1', skipped_at: '2026-05-17T10:00:00.000Z' }),
    ).not.toThrow();
    expect(() =>
      schema.parse({
        application_id: 'a1',
        skipped_at: '2026-05-17T10:00:00.000Z',
        reason: 'role mismatch',
      }),
    ).not.toThrow();
  });

  it('application:ready_for_manual_apply payload exposes job_id and an optional cover_letter_path', () => {
    const schema = EVENT_PAYLOADS['application:ready_for_manual_apply'];
    expect(() =>
      schema.parse({
        application_id: 'a1',
        job_id: 'j1',
        external_apply_url: 'https://example.com/apply',
        tailored_cv_path: '/tmp/cv.docx',
        tailored_cover_letter_path: null,
      }),
    ).not.toThrow();
  });
});

describe('EVENTS — multi-source slice additions', () => {
  it('includes SEARCH_CANCELLED', () => {
    expect((EVENTS as Record<string, string>)['SEARCH_CANCELLED']).toBe('search:cancelled');
  });

  it('search:cancelled payload validates listings_added and scored', () => {
    const schema = EVENT_PAYLOADS['search:cancelled'];
    expect(() =>
      schema.parse({
        task_id: 't1',
        site_id: 'google',
        listings_added: 3,
        scored: 2,
      }),
    ).not.toThrow();
  });

  it('search:cancelled payload rejects negative counts', () => {
    const schema = EVENT_PAYLOADS['search:cancelled'];
    expect(() =>
      schema.parse({ task_id: 't1', site_id: 'google', listings_added: -1, scored: 0 }),
    ).toThrow();
  });
});
