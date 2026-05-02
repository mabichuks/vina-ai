import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * The standard shadcn class-name helper. Combines `clsx` (conditional class
 * logic) with `tailwind-merge` (deduplicates conflicting Tailwind utilities,
 * so e.g. `cn('p-2', 'p-4')` collapses to just `p-4`). Used by every
 * `components/ui/*` component for variant composition.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
