/**
 * Re-export of the schema + types for the saveTailoredCv tool. Kept in its
 * own file so callers (server tool factories, future LangChain Tool wrappers)
 * can import a single narrow surface.
 */
export {
  SaveTailoredCvInputSchema,
  type SaveTailoredCvInput,
  type SaveTailoredFileResult,
} from './types.js';
