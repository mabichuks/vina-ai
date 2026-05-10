import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { Database as DatabaseType } from 'better-sqlite3';
import {
  createBrowserManager,
  linkedInAdapter,
  type BrowserManagerHandle,
} from '@vina/automation';
import { startLinkedInFixture } from '../../../../../tests/fixtures/sites/linkedin/server.js';
import type { FixtureServerHandle } from '../../../../../tests/fixtures/start-server.js';
import { listJobs } from '../../../src/db/repositories/jobs.js';
import { listPending } from '../../../src/db/repositories/task-queue.js';
import { listAlerts } from '../../../src/db/repositories/alerts.js';
import {
  findScheduleById,
  insertSchedule,
} from '../../../src/db/repositories/schedules.js';
import { getOrInitSearchPreferences } from '../../../src/db/repositories/search-preferences.js';
import { createEventBus } from '../../../src/events/bus.js';
import { createSearchHandler } from '../../../src/queue/handlers/search.js';
import { freshTestDb } from '../../db/helpers.js';

let fixture: FixtureServerHandle;
beforeAll(async () => {
  fixture = await startLinkedInFixture();
});
afterAll(async () => {
  await fixture.close();
});

let db: DatabaseType;
let dataDir: string;
let bm: BrowserManagerHandle;
beforeEach(() => {
  db = freshTestDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-search-'));
  bm = createBrowserManager({ dataDir });
  getOrInitSearchPreferences(db);
});
afterEach(async () => {
  await bm.closeAll();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('search handler — real LinkedIn flow', () => {
  it('inserts jobs from the fixture and enqueues a score task per listing', async () => {
    const handler = createSearchHandler({
      db,
      bus: createEventBus(),
      browserManager: bm,
      adapters: { linkedin: linkedInAdapter },
      feedUrlOverride: `${fixture.url}/feed`,
    });

    await handler({ site_id: 'linkedin' });

    const jobs = listJobs(db, { site_id: 'linkedin' });
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    const scoreTasks = listPending(db).filter((t) => t.kind === 'score');
    expect(scoreTasks.length).toBe(jobs.length);
  }, 60_000);

  it('emits a linkedin_session_expired alert and throws when page is /login', async () => {
    const handler = createSearchHandler({
      db,
      bus: createEventBus(),
      browserManager: bm,
      adapters: { linkedin: linkedInAdapter },
      feedUrlOverride: `${fixture.url}/login`,
    });

    await expect(handler({ site_id: 'linkedin' })).rejects.toThrow(/session/i);
    const alerts = listAlerts(db, { kind: 'linkedin_session_expired' });
    expect(alerts.length).toBe(1);
  }, 60_000);

  it('increments schedule failures and pauses after 3 strikes', async () => {
    const sch = insertSchedule(db, { cron_expression: '*/15 * * * *' });
    const handler = createSearchHandler({
      db,
      bus: createEventBus(),
      browserManager: bm,
      adapters: { linkedin: linkedInAdapter },
      feedUrlOverride: `${fixture.url}/login`,
    });

    for (let i = 0; i < 3; i++) {
      await expect(
        handler({ site_id: 'linkedin', schedule_id: sch.id }),
      ).rejects.toThrow();
    }
    const fresh = findScheduleById(db, sch.id);
    expect(fresh?.consecutive_failures).toBe(3);
    expect(fresh?.paused).toBe(true);
    expect(listAlerts(db, { kind: 'schedule_paused' }).length).toBe(1);
  }, 90_000);

  it('rejects unknown site ids', async () => {
    const handler = createSearchHandler({
      db,
      bus: createEventBus(),
      browserManager: bm,
      adapters: { linkedin: linkedInAdapter },
    });
    await expect(handler({ site_id: 'unknown' })).rejects.toThrow(/site/i);
  });
});
