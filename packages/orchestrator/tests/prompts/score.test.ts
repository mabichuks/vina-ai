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
});
