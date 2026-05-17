import { z } from 'zod';

/**
 * Buffer is not a built-in zod type. We use a refinement so the schema works
 * in browsers (Buffer is undefined there) and Node alike — the orchestrator
 * runs in Node, but typecheck happens against the shared bundle.
 */
const BufferSchema = z.custom<Buffer>(
  (v) => typeof Buffer !== 'undefined' && Buffer.isBuffer(v),
  { message: 'expected Node Buffer' },
);

export const SaveTailoredCvInputSchema = z.object({
  application_id: z.string().min(1),
  docx: BufferSchema,
});
export type SaveTailoredCvInput = z.infer<typeof SaveTailoredCvInputSchema>;

export const SaveTailoredCoverLetterInputSchema = z.object({
  application_id: z.string().min(1),
  docx: BufferSchema,
});
export type SaveTailoredCoverLetterInput = z.infer<typeof SaveTailoredCoverLetterInputSchema>;

export interface SaveTailoredFileResult {
  /** Absolute on-disk path. The server resolves relative paths against dataDir. */
  path: string;
}

/**
 * Tool kit passed into the prepare-manual-apply graph at invocation time.
 * The orchestrator never imports the server or automation packages; the
 * caller supplies the implementations (see packages/server/src/orchestrator/
 * tools/). This mirrors the selectorResolver DI in resolve-selector.ts.
 */
export interface ManualApplyToolKit {
  saveTailoredCv(input: SaveTailoredCvInput): Promise<SaveTailoredFileResult>;
  saveTailoredCoverLetter(input: SaveTailoredCoverLetterInput): Promise<SaveTailoredFileResult>;
}
