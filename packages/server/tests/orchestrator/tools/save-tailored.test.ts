import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createManualApplyToolKit } from '../../../src/orchestrator/tools/index.js';

let dataDir: string;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vina-tk-'));
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('manual-apply tool kit (server impl)', () => {
  it('saveTailoredCv writes to <dataDir>/files/tailored/<app_id>.docx with 0600 perms', async () => {
    const kit = createManualApplyToolKit({ dataDir });
    const buf = Buffer.from('docx-bytes', 'utf8');
    const result = await kit.saveTailoredCv({ application_id: 'a1', docx: buf });
    expect(result.path).toBe(path.join(dataDir, 'files', 'tailored', 'a1.docx'));
    expect(fs.readFileSync(result.path).toString()).toBe('docx-bytes');
    const stat = fs.statSync(result.path);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('saveTailoredCoverLetter writes under files/tailored-cover-letters/', async () => {
    const kit = createManualApplyToolKit({ dataDir });
    const result = await kit.saveTailoredCoverLetter({
      application_id: 'a2',
      docx: Buffer.from('cl', 'utf8'),
    });
    expect(result.path).toBe(
      path.join(dataDir, 'files', 'tailored-cover-letters', 'a2.docx'),
    );
  });

  it('creates the target directory on demand', async () => {
    const kit = createManualApplyToolKit({ dataDir });
    await kit.saveTailoredCv({ application_id: 'a3', docx: Buffer.from('x') });
    expect(fs.existsSync(path.join(dataDir, 'files', 'tailored'))).toBe(true);
  });

  it('rejects application_ids containing path separators', async () => {
    const kit = createManualApplyToolKit({ dataDir });
    await expect(
      kit.saveTailoredCv({ application_id: '../escape', docx: Buffer.from('x') }),
    ).rejects.toThrow(/invalid/i);
  });
});
