import { describe, expect, it } from 'vitest';
import { SCORE_SYSTEM, scoreUserPrompt } from '../../src/prompts/score.js';

describe('score prompt', () => {
  it('system prompt includes the documented rubric weights', () => {
    expect(SCORE_SYSTEM).toContain('Title fit');
    expect(SCORE_SYSTEM).toContain('40%');
    expect(SCORE_SYSTEM).toContain('Skills');
    expect(SCORE_SYSTEM).toContain('30%');
    expect(SCORE_SYSTEM).toContain('Seniority');
    expect(SCORE_SYSTEM).toContain('Location');
    expect(SCORE_SYSTEM).toContain('15%');
    expect(SCORE_SYSTEM).toContain('Excluded companies');
    expect(SCORE_SYSTEM).toContain('"score"');
    expect(SCORE_SYSTEM).toContain('"justification"');
  });

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
