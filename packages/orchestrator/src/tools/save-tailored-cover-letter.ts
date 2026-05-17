/**
 * Re-export of the schema + types for the saveTailoredCoverLetter tool. Kept
 * in its own file so callers (server tool factories, future LangChain Tool
 * wrappers) can import a single narrow surface.
 */
export {
  SaveTailoredCoverLetterInputSchema,
  type SaveTailoredCoverLetterInput,
  type SaveTailoredFileResult,
} from './types.js';
