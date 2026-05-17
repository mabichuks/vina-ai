import { z } from 'zod';
import { ProviderError } from '@vina/shared';
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx';
import {
  TAILOR_CV_SYSTEM,
  tailorCvUserPrompt,
  type TailorCvInput,
} from '../prompts/tailor-cv.js';
import type { StructuredScorer, ScoreMessages } from './score-job.js';

export const TailorCvOutputSchema = z.object({
  summary: z.string().min(1),
  bullets: z.array(z.object({ section: z.string(), bullet: z.string() })),
  skills: z.array(z.string()),
});
export type TailorCvOutput = z.infer<typeof TailorCvOutputSchema>;

const MAX_ATTEMPTS = 2;
const MAX_CV_CHARS = 14_000; // ~3500 tokens at 4 chars/token
const MAX_JOB_CHARS = 6_000; // ~1500 tokens

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n\n[…truncated]`;
}

export async function runTailorCv(
  input: TailorCvInput,
  model: StructuredScorer,
): Promise<TailorCvOutput> {
  const trimmed: TailorCvInput = {
    ...input,
    source_cv_text: truncate(input.source_cv_text, MAX_CV_CHARS),
    job: { ...input.job, description: truncate(input.job.description, MAX_JOB_CHARS) },
  };

  const structured = model.withStructuredOutput(TailorCvOutputSchema);
  const messages: ScoreMessages = [
    { role: 'system', content: TAILOR_CV_SYSTEM },
    { role: 'user', content: tailorCvUserPrompt(trimmed) },
  ];

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await structured.invoke(messages);
    } catch (err) {
      lastError = err;
    }
  }
  throw new ProviderError('tailor-cv graph failed after retry', {
    cause: lastError instanceof Error ? lastError.message : String(lastError),
  });
}

export interface TailorCvHeader {
  full_name: string;
  email: string;
}

/**
 * Pure, deterministic — produces a single-section DOCX with header / summary /
 * grouped experience bullets / skills. No LLM involvement past this point so
 * the file is guaranteed to be valid. MVP single template per spec §3.1.
 * Async because docx's `Packer.toBuffer` returns a Promise.
 */
export async function renderTailoredDocx(
  out: TailorCvOutput,
  header: TailorCvHeader,
): Promise<Buffer> {
  const children: Paragraph[] = [];

  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: header.full_name, bold: true })],
    }),
  );
  children.push(new Paragraph({ children: [new TextRun({ text: header.email })] }));
  children.push(new Paragraph({ text: '' }));

  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, text: 'Summary' }));
  children.push(new Paragraph({ text: out.summary }));
  children.push(new Paragraph({ text: '' }));

  // Group bullets by section to preserve experience structure.
  const bySection = new Map<string, string[]>();
  for (const b of out.bullets) {
    const arr = bySection.get(b.section) ?? [];
    arr.push(b.bullet);
    bySection.set(b.section, arr);
  }

  if (bySection.size > 0) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, text: 'Experience' }));
    for (const [section, bullets] of bySection) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, text: section }));
      for (const bullet of bullets) {
        children.push(new Paragraph({ text: bullet, bullet: { level: 0 } }));
      }
    }
    children.push(new Paragraph({ text: '' }));
  }

  if (out.skills.length > 0) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, text: 'Skills' }));
    children.push(new Paragraph({ text: out.skills.join(' · ') }));
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc) as unknown as Promise<Buffer>;
}
