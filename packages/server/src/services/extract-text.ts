import { createLogger } from '@vina/shared';

const log = createLogger('extract-text');

/**
 * Extract text from an uploaded CV/cover-letter file. Returns an empty string
 * for unsupported types or parse failures (the row still saves) — this is the
 * behaviour spelled out in PRD-075/076 acceptance.
 */
export async function extractTextFromBuffer(buffer: Buffer, mime: string): Promise<string> {
  try {
    if (mime === 'application/pdf') {
      // Lazy import: pdf-parse pulls in a fairly large dep tree, only paid for
      // when a CV is actually uploaded.
      const pdfParse = (await import('pdf-parse')).default;
      const result = await pdfParse(buffer);
      return result.text.trim();
    }
    if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      return result.value.trim();
    }
    return '';
  } catch (err) {
    log.warn({ err, mime }, 'text extraction failed; saving row with empty text');
    return '';
  }
}
