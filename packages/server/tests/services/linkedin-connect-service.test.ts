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
import { startLinkedInFixture } from '../../../../tests/fixtures/sites/linkedin/server.js';
import type { FixtureServerHandle } from '../../../../tests/fixtures/start-server.js';
import { createEventBus } from '../../src/events/bus.js';
import { findSiteById } from '../../src/db/repositories/sites.js';
import { createLinkedInConnectService } from '../../src/services/linkedin-connect-service.js';
import { freshTestDb } from '../db/helpers.js';

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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-link-'));
  bm = createBrowserManager({ dataDir });
});
afterEach(async () => {
  await bm.closeAll();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('linkedin-connect-service', () => {
  it('reports connected:false attempting:false initially', () => {
    const svc = createLinkedInConnectService({
      db,
      bus: createEventBus(),
      browserManager: bm,
      adapter: linkedInAdapter,
      dataDir,
      useManagerForLaunch: true,
    });
    expect(svc.getStatus()).toMatchObject({
      connected: false,
      attempting: false,
      last_success_at: null,
    });
  });

  it('hydrates last_success_at from the persisted site session on creation', () => {
    const ts = '2026-05-09T12:00:00.000Z';
    db.prepare(
      `UPDATE sites SET session_path = ?, session_valid_at = ?, enabled = 1 WHERE id = 'linkedin'`,
    ).run('linkedin', ts);
    const svc = createLinkedInConnectService({
      db,
      bus: createEventBus(),
      browserManager: bm,
      adapter: linkedInAdapter,
      dataDir,
      useManagerForLaunch: true,
    });
    expect(svc.getStatus()).toMatchObject({
      connected: true,
      attempting: false,
      last_success_at: ts,
    });
  });

  it('flips to connected after detecting onLoginSuccess and persists site session', async () => {
    const svc = createLinkedInConnectService({
      db,
      bus: createEventBus(),
      browserManager: bm,
      adapter: linkedInAdapter,
      dataDir,
      useManagerForLaunch: true,
      loginUrlOverride: `${fixture.url}/login`,
      onLoginSuccessNavigationOverride: `${fixture.url}/feed`,
      pollIntervalMs: 50,
      timeoutMs: 5_000,
    });
    await svc.startConnect();

    expect(svc.getStatus()).toMatchObject({ connected: true, attempting: false });
    const site = findSiteById(db, 'linkedin');
    expect(site?.enabled).toBe(true);
    expect(site?.session_valid_at).toBeTruthy();
  }, 30_000);

  it('startConnect is idempotent while attempting', async () => {
    // Use a long timeout + no auto-success so the attempt lingers in
    // attempting state long enough to call startConnect twice.
    const svc = createLinkedInConnectService({
      db,
      bus: createEventBus(),
      browserManager: bm,
      adapter: linkedInAdapter,
      dataDir,
      useManagerForLaunch: true,
      loginUrlOverride: `${fixture.url}/login`,
      pollIntervalMs: 5_000,
      timeoutMs: 60_000,
    });
    await svc.startConnect();
    expect(svc.getStatus().attempting).toBe(true);
    await svc.startConnect();
    expect(svc.getStatus().attempting).toBe(true);
    await svc.cancelConnect();
  }, 30_000);

  it('disconnect clears persisted session and disables the site', async () => {
    const svc = createLinkedInConnectService({
      db,
      bus: createEventBus(),
      browserManager: bm,
      adapter: linkedInAdapter,
      dataDir,
      useManagerForLaunch: true,
      loginUrlOverride: `${fixture.url}/login`,
      onLoginSuccessNavigationOverride: `${fixture.url}/feed`,
      pollIntervalMs: 50,
      timeoutMs: 5_000,
    });
    await svc.startConnect();
    expect(svc.getStatus().connected).toBe(true);

    await svc.disconnect();
    expect(svc.getStatus().connected).toBe(false);
    const site = findSiteById(db, 'linkedin');
    expect(site?.enabled).toBe(false);
    expect(site?.session_valid_at).toBeNull();
  }, 30_000);
});
