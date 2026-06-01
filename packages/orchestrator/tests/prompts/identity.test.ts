import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createPromptLoader } from '../../src/prompts/loader.js';
import { SCORE_SYSTEM } from '../../src/prompts/score.js';
import { TAILOR_CV_SYSTEM } from '../../src/prompts/tailor-cv.js';
import { TAILOR_COVER_LETTER_SYSTEM } from '../../src/prompts/tailor-cover-letter.js';

const loader = createPromptLoader({
  defaultsDir: fileURLToPath(new URL('../../prompts/', import.meta.url)),
});

/**
 * The Markdown defaults must render byte-identical to the existing in-code
 * constants. The migration in Chunk 8 then flips each graph to the loader
 * without changing any LLM-visible bytes — making the move a pure refactor.
 */
describe('prompt identity (migration safety)', () => {
  it('score.md body === SCORE_SYSTEM', async () => {
    const rendered = await loader.render('score');
    expect(rendered).toBe(SCORE_SYSTEM);
  });

  it('tailor-cv.md body === TAILOR_CV_SYSTEM', async () => {
    const rendered = await loader.render('tailor-cv');
    expect(rendered).toBe(TAILOR_CV_SYSTEM);
  });

  it('tailor-cover-letter.md body === TAILOR_COVER_LETTER_SYSTEM', async () => {
    const rendered = await loader.render('tailor-cover-letter');
    expect(rendered).toBe(TAILOR_COVER_LETTER_SYSTEM);
  });

  it('system-base.md has the no-fabricate base content', async () => {
    const doc = await loader.load('system-base');
    expect(doc.editableByUser).toBe(false);
    expect(doc.body).toMatch(/Never fabricate facts about the user/);
  });
});
