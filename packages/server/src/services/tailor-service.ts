import { z } from 'zod';
import PDFDocument from 'pdfkit';
import { ProviderError } from '@vina/shared';
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx';
import type { StructuredScorer } from '@vina/orchestrator';

/**
 * CV tailoring for the **Easy Apply** path, relocated out of the
 * orchestrator's `graphs/tailor-cv.ts` (deleted in #19). The manual-apply
 * path no longer uses this: the agent writes markdown prose and
 * `vina_materials_save` renders it deterministically (see
 * `materials-renderer.ts`). Easy Apply still needs the structured
 * tailor-then-render flow and moves to sessions in #20.
 *
 * The system prompt and user-prompt builder below are ported **verbatim**
 * from the deleted `packages/orchestrator/prompts/tailor-cv.ts` /
 * `tailor-cv.md` (issue Notes forbid re-authoring).
 */

export const TailorCvOutputSchema = z.object({
  summary: z.string().min(1),
  bullets: z.array(z.object({ section: z.string(), bullet: z.string() })),
  skills: z.array(z.string()),
});
export type TailorCvOutput = z.infer<typeof TailorCvOutputSchema>;

export interface TailorCvInput {
  job: {
    title: string;
    company: string;
    description: string;
  };
  source_cv_text: string;
  user_profile: {
    full_name: string;
    bio: string | null;
  };
}

export function tailorCvUserPrompt(input: TailorCvInput): string {
  const { job, source_cv_text, user_profile } = input;
  const lines: string[] = [];

  lines.push('## Job');
  lines.push(`Title: ${job.title}`);
  lines.push(`Company: ${job.company}`);
  lines.push('Description:');
  lines.push(job.description);
  lines.push('');

  lines.push('## User profile');
  lines.push(`Name: ${user_profile.full_name}`);
  if (user_profile.bio) lines.push(`Bio: ${user_profile.bio}`);
  lines.push('');

  lines.push('## Source CV');
  lines.push(source_cv_text);

  return lines.join('\n');
}

const TAILOR_CV_SYSTEM_PROMPT = `You are Vina, a CV tailor.

Given a job listing and a user's source CV, produce a structured rewrite that emphasises the bits of the user's experience most relevant to this job. You are not writing fiction — every claim in the output MUST trace back to the source CV.

## Hard rules

- DO NOT invent employers, dates, titles, technologies, certifications, or quantitative outcomes that are not in the source CV.
- DO NOT fabricate metrics ("scaled to 1M users") if the source CV does not state them.
- DO rephrase, re-order, and select what to surface. Promote skills that overlap with the job description; drop bullets that are irrelevant.
- DO keep all dates, employers, titles, and proper nouns verbatim from the source CV.
- DO write in the user's voice (first-person implicit, past tense for past roles).

## Example

Source CV says: "FooCo, 2020-2024 — built Postgres ingestion pipeline handling 50k events/min."
Job wants: "Postgres expertise, high-throughput data engineering."

GOOD rewrite: "FooCo, 2020-2024 — designed and ran a Postgres ingestion pipeline at 50k events/min, with Postgres tuning and partitioning as the operative bottleneck."
BAD rewrite: "FooCo, 2020-2024 — scaled Postgres pipeline to 5M events/min using citus and BigQuery." (invented numbers + invented tech)

## Output schema

Return JSON exactly matching:

{
  "summary": "<2-3 sentence top-of-CV summary tailored to the job>",
  "bullets": [{ "section": "<Section label, e.g. 'FooCo, 2020-2024'>", "bullet": "<single rewritten bullet>" }],
  "skills": ["<promoted skill>", "..."]
}

Sections in "bullets" should match the source CV's section headings as closely as possible. Bullets are single-sentence prose, not nested lists.`;

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
  const messages: ReadonlyArray<{ role: 'system' | 'user'; content: string }> = [
    { role: 'system', content: TAILOR_CV_SYSTEM_PROMPT },
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

/**
 * Same `TailorCvOutput` rendered into a PDF instead of DOCX. Deterministic —
 * no LLM involvement. Layout mirrors the DOCX template (title / contact /
 * summary / experience by section / skills) so the two artefacts are visually
 * equivalent. PDFs are the right pick for portfolios and ATS pipelines that
 * reject DOCX; DOCX is the right pick for further editing.
 */
export async function renderTailoredPdf(
  out: TailorCvOutput,
  header: TailorCvHeader,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 56 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc.font('Helvetica-Bold').fontSize(20).text(header.full_name);
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(10).text(header.email);
    doc.moveDown(0.8);

    // Summary
    doc.font('Helvetica-Bold').fontSize(13).text('Summary');
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(11).text(out.summary, { align: 'left' });
    doc.moveDown(0.8);

    // Experience grouped by section
    const bySection = new Map<string, string[]>();
    for (const b of out.bullets) {
      const arr = bySection.get(b.section) ?? [];
      arr.push(b.bullet);
      bySection.set(b.section, arr);
    }
    if (bySection.size > 0) {
      doc.font('Helvetica-Bold').fontSize(13).text('Experience');
      doc.moveDown(0.2);
      for (const [section, bullets] of bySection) {
        doc.font('Helvetica-Bold').fontSize(11).text(section);
        doc.moveDown(0.1);
        for (const bullet of bullets) {
          doc.font('Helvetica').fontSize(10.5).text(`• ${bullet}`, { indent: 14 });
        }
        doc.moveDown(0.4);
      }
    }

    // Skills
    if (out.skills.length > 0) {
      doc.font('Helvetica-Bold').fontSize(13).text('Skills');
      doc.moveDown(0.2);
      doc.font('Helvetica').fontSize(11).text(out.skills.join(' · '));
    }

    doc.end();
  });
}
