import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createPromptLoader } from '../../src/prompts/loader.js';
import { scoreUserPrompt } from '../../src/prompts/score.js';

const loader = createPromptLoader({
  defaultsDir: fileURLToPath(new URL('../../prompts/', import.meta.url)),
});

describe('score system prompt (loaded from prompts/score.md)', () => {
  it('includes the documented rubric weights', async () => {
    const body = await loader.render('score');
    expect(body).toContain('Title fit');
    expect(body).toContain('40%');
    expect(body).toContain('Skills');
    expect(body).toContain('30%');
    expect(body).toContain('Seniority');
    expect(body).toContain('Location');
    expect(body).toContain('15%');
    expect(body).toContain('Excluded companies');
    expect(body).toContain('"score"');
    expect(body).toContain('"justification"');
  });
});

describe('scoreUserPrompt', () => {
  it('user prompt renders profile, prefs, and listing into stable sections', () => {
    const out = scoreUserPrompt({
      job: {
        title: 'Senior Backend Engineer',
        company: 'Acme',
        location: 'Remote',
        description: 'We use Go and Kafka.',
      },
      profile: { full_name: 'Ada', bio: 'Mathematician.' },
      prefs: {
        description: 'Senior backend, EU-friendly remote',
        keywords: ['typescript', 'go'],
        locations: ['Remote'],
        work_models: ['remote'],
        seniority: ['senior'],
        excluded_companies: ['EvilCorp'],
      },
    });
    expect(out).toMatchInlineSnapshot(`
      "## User profile
      Name: Ada
      Bio: Mathematician.

      ## Search preferences
      Description: Senior backend, EU-friendly remote
      Keywords: typescript, go
      Locations: Remote
      Work models: remote
      Seniority: senior
      Excluded companies: EvilCorp

      ## Job listing
      Title: Senior Backend Engineer
      Company: Acme
      Location: Remote

      Description:
      We use Go and Kafka."
    `);
  });

  it('omits empty preference sections', () => {
    const out = scoreUserPrompt({
      job: { title: 't', company: 'c', location: null, description: 'd' },
      profile: { full_name: 'x', bio: null },
      prefs: {
        description: '',
        keywords: [],
        locations: [],
        work_models: [],
        seniority: [],
        excluded_companies: [],
      },
    });
    expect(out).not.toContain('Keywords');
    expect(out).not.toContain('Locations');
    expect(out).not.toContain('Bio');
  });

  it('omits the CV section when cv_text is undefined or empty', () => {
    const base = {
      job: { title: 't', company: 'c', location: null, description: 'd' },
      profile: { full_name: 'x', bio: null },
      prefs: {
        description: '',
        keywords: [],
        locations: [],
        work_models: [],
        seniority: [],
        excluded_companies: [],
      },
    };
    expect(scoreUserPrompt(base)).not.toMatch(/## CV/);
    expect(scoreUserPrompt({ ...base, cv_text: '' })).not.toMatch(/## CV/);
    expect(scoreUserPrompt({ ...base, cv_text: '   ' })).not.toMatch(/## CV/);
  });

  it('renders a CV section between Profile and Search preferences when cv_text is set', () => {
    const out = scoreUserPrompt({
      job: { title: 't', company: 'c', location: null, description: 'd' },
      profile: { full_name: 'Ada', bio: null },
      cv_text: 'Worked on Postgres pipelines.',
      prefs: {
        description: '',
        keywords: [],
        locations: [],
        work_models: [],
        seniority: [],
        excluded_companies: [],
      },
    });
    const profileIdx = out.indexOf('## User profile');
    const cvIdx = out.indexOf('## CV');
    const prefsIdx = out.indexOf('## Search preferences');
    expect(cvIdx).toBeGreaterThan(profileIdx);
    expect(prefsIdx).toBeGreaterThan(cvIdx);
    expect(out).toContain('Worked on Postgres pipelines.');
  });
});
