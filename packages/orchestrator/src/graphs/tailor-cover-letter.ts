import { z } from 'zod';
import { ProviderError } from '@vina/shared';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import {
  TAILOR_COVER_LETTER_SYSTEM,
  tailorCoverLetterUserPrompt,
  type TailorCoverLetterInput,
} from '../prompts/tailor-cover-letter.js';
import type { StructuredScorer, ScoreMessages } from './score-job.js';

export const TailorCoverLetterOutputSchema = z.object({
  greeting: z.string().min(1),
  body_paragraphs: z.array(z.string()).min(1),
  closing: z.string().min(1),
});
export type TailorCoverLetterOutput = z.infer<typeof TailorCoverLetterOutputSchema>;

const MAX_ATTEMPTS = 2;
const MAX_TEMPLATE_CHARS = 8_000;
const MAX_JOB_CHARS = 6_000;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n\n[…truncated]`;
}

export async function runTailorCoverLetter(
  input: TailorCoverLetterInput,
  model: StructuredScorer,
): Promise<TailorCoverLetterOutput> {
  const trimmed: TailorCoverLetterInput = {
    ...input,
    source_template: truncate(input.source_template, MAX_TEMPLATE_CHARS),
    job: { ...input.job, description: truncate(input.job.description, MAX_JOB_CHARS) },
  };
  const structured = model.withStructuredOutput(TailorCoverLetterOutputSchema);
  const messages: ScoreMessages = [
    { role: 'system', content: TAILOR_COVER_LETTER_SYSTEM },
    { role: 'user', content: tailorCoverLetterUserPrompt(trimmed) },
  ];

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await structured.invoke(messages);
    } catch (err) {
      lastError = err;
    }
  }
  throw new ProviderError('tailor-cover-letter graph failed after retry', {
    cause: lastError instanceof Error ? lastError.message : String(lastError),
  });
}

export interface CoverLetterHeader {
  full_name: string;
  email: string;
}

export async function renderTailoredCoverLetterDocx(
  out: TailorCoverLetterOutput,
  header: CoverLetterHeader,
): Promise<Buffer> {
  const children: Paragraph[] = [];

  children.push(
    new Paragraph({ children: [new TextRun({ text: header.full_name, bold: true })] }),
  );
  children.push(new Paragraph({ children: [new TextRun({ text: header.email })] }));
  children.push(new Paragraph({ text: '' }));

  children.push(new Paragraph({ text: out.greeting }));
  children.push(new Paragraph({ text: '' }));

  for (const para of out.body_paragraphs) {
    children.push(new Paragraph({ text: para }));
    children.push(new Paragraph({ text: '' }));
  }

  children.push(new Paragraph({ text: out.closing }));

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc) as unknown as Promise<Buffer>;
}
