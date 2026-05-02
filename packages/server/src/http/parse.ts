import type { z } from 'zod';
import { ValidationError } from '@vina/shared';

/**
 * Run a zod schema against unknown input, raising a `ValidationError` (which
 * the global error handler turns into a 400 envelope) instead of letting the
 * raw `ZodError` bubble up as a 500.
 *
 * The generic `S extends z.ZodTypeAny` lets `z.infer<S>` flow back to call
 * sites — schemas like `SettingsUpdateSchema` keep their full property shape.
 */
export function parse<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
  what = 'request body',
): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    // Summarise the failing fields in the message so the toast is actionable
    // ("Invalid request body: email — invalid email") rather than just
    // "Invalid request body". The full issues list still rides on `details`
    // for inline UI rendering.
    const summary = result.error.issues
      .map((i) => {
        const path = i.path.join('.') || '<root>';
        return `${path} — ${i.message}`;
      })
      .join('; ');
    throw new ValidationError(`Invalid ${what}: ${summary}`, result.error.issues);
  }
  return result.data;
}
