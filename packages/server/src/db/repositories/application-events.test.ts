import { describe, expect, it } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { freshTestDb } from '../test-helpers.js';
import { insertCv } from './cvs.js';
import { insertJob } from './jobs.js';
import { insertApplication } from './applications.js';
import { appendEvent, listEvents } from './application-events.js';

function seedApp(db: DatabaseType): string {
  const cv = insertCv(db, {
    label: 'Default',
    original_filename: 'cv.pdf',
    mime_type: 'application/pdf',
    file_path: 'cv.pdf',
  });
  const job = insertJob(db, {
    site_id: 'linkedin',
    external_id: 'x',
    url: 'https://x',
    apply_method: 'auto',
    title: 't',
    company: 'c',
    description: 'd',
  });
  const app = insertApplication(db, {
    job_id: job.id,
    cv_id: cv.id,
    apply_method: 'auto',
  });
  return app.id;
}

describe('application_events repository', () => {
  it('listEvents returns events in insertion order', () => {
    const db = freshTestDb();
    const appId = seedApp(db);

    appendEvent(db, { application_id: appId, kind: 'created' });
    appendEvent(db, { application_id: appId, kind: 'cv_tailored', payload: { path: 'a' } });
    appendEvent(db, { application_id: appId, kind: 'apply_started' });

    const events = listEvents(db, appId);
    expect(events.map((e) => e.kind)).toEqual(['created', 'cv_tailored', 'apply_started']);
    db.close();
  });

  it('serialises non-string payloads to JSON', () => {
    const db = freshTestDb();
    const appId = seedApp(db);
    appendEvent(db, {
      application_id: appId,
      kind: 'cv_tailored',
      payload: { path: 'tailored.docx', score: 92 },
    });
    const [event] = listEvents(db, appId);
    expect(event?.payload).toBe('{"path":"tailored.docx","score":92}');
    db.close();
  });

  it('passes through string payloads as-is', () => {
    const db = freshTestDb();
    const appId = seedApp(db);
    appendEvent(db, {
      application_id: appId,
      kind: 'cv_tailored',
      payload: '{"already":"stringified"}',
    });
    const [event] = listEvents(db, appId);
    expect(event?.payload).toBe('{"already":"stringified"}');
    db.close();
  });

  it('null payload stays null', () => {
    const db = freshTestDb();
    const appId = seedApp(db);
    appendEvent(db, { application_id: appId, kind: 'created' });
    const [event] = listEvents(db, appId);
    expect(event?.payload).toBeNull();
    db.close();
  });
});
