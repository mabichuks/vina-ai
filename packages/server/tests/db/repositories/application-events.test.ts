import { describe, expect, it } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { appendEvent, listEvents } from '../../../src/db/repositories/application-events.js';
import { insertApplication } from '../../../src/db/repositories/applications.js';
import { insertCv } from '../../../src/db/repositories/cvs.js';
import { insertJob } from '../../../src/db/repositories/jobs.js';
import { freshTestDb } from '../helpers.js';

function seedApp(db: DatabaseType): string {
  const cv = insertCv(db, {
    label: 'A',
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
  return insertApplication(db, { job_id: job.id, cv_id: cv.id, apply_method: 'auto' }).id;
}

describe('application_events repository', () => {
  it('listEvents returns events in insertion order; payloads serialise consistently', () => {
    const db = freshTestDb();
    const appId = seedApp(db);
    appendEvent(db, { application_id: appId, kind: 'created' });
    appendEvent(db, {
      application_id: appId,
      kind: 'cv_tailored',
      payload: { path: 't.docx' },
    });
    appendEvent(db, { application_id: appId, kind: 'apply_started' });

    const events = listEvents(db, appId);
    expect(events.map((e) => e.kind)).toEqual(['created', 'cv_tailored', 'apply_started']);
    expect(events[0]?.payload).toBeNull();
    expect(events[1]?.payload).toBe('{"path":"t.docx"}');
    db.close();
  });
});
