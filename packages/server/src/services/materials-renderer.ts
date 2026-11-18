import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import {
  renderTailoredDocx,
  renderTailoredPdf,
  type TailorCvHeader,
  type TailorCvOutput,
} from './tailor-service.js';

/**
 * Deterministic markdown → DOCX/PDF renderer (ADR-024 §1: rendering is Vina's
 * output, not a re-tailoring LLM call). `vina_materials_save` feeds the
 * agent's prose here; the agent never authors the document structure itself.
 *
 * Markdown maps onto the **existing** tailored-document layout (no new
 * layout): a fixed heading grammar is parsed into the same `TailorCvOutput`
 * shape the structured renderers consume, and the cover letter maps to the
 * same greeting / paragraphs / closing layout the deleted
 * `renderTailoredCoverLetterDocx` produced.
 */

// ---------------------------------------------------------------------------
// CV markdown grammar
// ---------------------------------------------------------------------------

export interface ParsedCvMarkdown {
  summary: string;
  bullets: Array<{ section: string; bullet: string }>;
  skills: string[];
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BULLET_RE = /^\s*[-*•]\s+(.*)$/;

/**
 * Parse the fixed CV heading grammar into `TailorCvOutput`:
 *
 * - `Summary` (any heading level) — summary prose.
 * - `## Experience` — begins experience; `### <section>` names each grouped
 *   section; list items under a section are its bullets.
 * - `## Skills` — skill list (bullets or comma-separated).
 *
 * Unknown headings are ignored; non-heading text in the summary section is
 * joined, and bullets outside a named section fall under "Experience".
 */
export function parseCvMarkdown(markdown: string): ParsedCvMarkdown {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');

  let mode: 'none' | 'summary' | 'experience' | 'skills' = 'none';
  let currentSection = 'Experience';
  const summaryParts: string[] = [];
  const bullets: Array<{ section: string; bullet: string }> = [];
  const skills: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const title = (heading[2] ?? '').trim();
      const lower = title.toLowerCase();
      if (lower === 'summary') {
        mode = 'summary';
      } else if (lower === 'experience') {
        mode = 'experience';
        currentSection = 'Experience';
      } else if (lower === 'skills') {
        mode = 'skills';
      } else if (mode === 'experience') {
        // `### <section>` (or any heading inside Experience) names a section.
        currentSection = title;
      }
      continue;
    }

    if (mode === 'summary') {
      summaryParts.push(line);
      continue;
    }

    if (mode === 'skills') {
      const bullet = BULLET_RE.exec(line);
      const text = bullet ? (bullet[1] ?? '').trim() : line;
      for (const skill of text.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
        skills.push(skill);
      }
      continue;
    }

    if (mode === 'experience') {
      const bullet = BULLET_RE.exec(line);
      const text = bullet ? (bullet[1] ?? '').trim() : line;
      bullets.push({ section: currentSection, bullet: text });
      continue;
    }
  }

  return {
    summary: summaryParts.join(' ').trim(),
    bullets,
    skills,
  };
}

export function renderCvMarkdownDocx(markdown: string, header: TailorCvHeader): Promise<Buffer> {
  return renderTailoredDocx(toTailorCvOutput(parseCvMarkdown(markdown)), header);
}

export function renderCvMarkdownPdf(markdown: string, header: TailorCvHeader): Promise<Buffer> {
  return renderTailoredPdf(toTailorCvOutput(parseCvMarkdown(markdown)), header);
}

function toTailorCvOutput(parsed: ParsedCvMarkdown): TailorCvOutput {
  return {
    summary: parsed.summary || ' ',
    bullets: parsed.bullets,
    skills: parsed.skills,
  };
}

// ---------------------------------------------------------------------------
// Cover-letter markdown grammar
// ---------------------------------------------------------------------------

export interface ParsedCoverLetterMarkdown {
  greeting: string;
  body_paragraphs: string[];
  closing: string;
}

export interface CoverLetterHeader {
  full_name: string;
  email: string;
}

/**
 * Cover letter grammar: greeting + paragraphs + closing. The first non-empty
 * line is the greeting, the last is the closing, and the lines between are
 * paragraphs (blank-line separated).
 */
export function parseCoverLetterMarkdown(markdown: string): ParsedCoverLetterMarkdown {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim());

  // Group into paragraphs on blank lines, dropping empties.
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line === '') {
      if (current.length > 0) {
        paragraphs.push(current.join(' '));
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paragraphs.push(current.join(' '));

  if (paragraphs.length === 0) {
    return { greeting: '', body_paragraphs: [], closing: '' };
  }

  // greeting = first paragraph, closing = last, body = the rest.
  const greeting = paragraphs[0]!;
  const closing = paragraphs[paragraphs.length - 1]!;
  const body_paragraphs =
    paragraphs.length > 1 ? paragraphs.slice(1, paragraphs.length - 1) : [];

  return { greeting, body_paragraphs, closing };
}

export async function renderCoverLetterMarkdownDocx(
  markdown: string,
  header: CoverLetterHeader,
): Promise<Buffer> {
  const out = parseCoverLetterMarkdown(markdown);
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

export async function renderCoverLetterMarkdownPdf(
  markdown: string,
  header: CoverLetterHeader,
): Promise<Buffer> {
  const out = parseCoverLetterMarkdown(markdown);
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 56 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(14).text(header.full_name);
    doc.font('Helvetica').fontSize(10).text(header.email);
    doc.moveDown(1.5);

    doc.font('Helvetica').fontSize(11).text(out.greeting);
    doc.moveDown(0.8);

    for (const para of out.body_paragraphs) {
      doc.font('Helvetica').fontSize(11).text(para, { align: 'left' });
      doc.moveDown(0.8);
    }

    doc.font('Helvetica').fontSize(11).text(out.closing);
    doc.end();
  });
}
