import {
  useCoverLetters,
  useSchedules,
  useSearchPreferences,
  useSettings,
} from '../api/resources.js';

interface OptionalStep {
  label: string;
  path: string;
}

/**
 * Compute whether each *optional* onboarding step is still at its default.
 * Used by the AppShell "Finish setup" pill (PRD-095): nudges the user to
 * complete cover letter, search prefs, schedule, mode if they skipped during
 * onboarding. Returns the first uncustomised step, or null when everything
 * has been touched.
 */
export function useFirstDefaultStep(): OptionalStep | null {
  const coverLetters = useCoverLetters();
  const preferences = useSearchPreferences();
  const schedules = useSchedules();
  const settings = useSettings();

  // Don't nag while data is still loading — return null so the pill stays
  // hidden until we have a confident view.
  if (
    coverLetters.isLoading ||
    preferences.isLoading ||
    schedules.isLoading ||
    settings.isLoading
  ) {
    return null;
  }

  if (coverLetters.data.length === 0) {
    return { label: 'Cover letter', path: '/onboarding/cover-letter' };
  }

  // Search preferences: still default if every signal-bearing field is empty
  // and the threshold is the documented skip default (70).
  const prefs = preferences.data;
  if (
    !prefs ||
    (prefs.description === '' &&
      prefs.keywords.length === 0 &&
      prefs.locations.length === 0 &&
      prefs.work_models.length === 0 &&
      prefs.seniority.length === 0 &&
      prefs.score_threshold === 70)
  ) {
    return { label: 'Search preferences', path: '/onboarding/preferences' };
  }

  // Schedule: still default if no row OR exactly the skip default cron.
  if (
    schedules.data.length === 0 ||
    (schedules.data.length === 1 && schedules.data[0]?.cron_expression === '0 9 * * *')
  ) {
    return { label: 'Schedule', path: '/onboarding/schedule' };
  }

  // Mode: still default if the user hasn't moved away from the conservative
  // 'manual' easy_apply_mode (the post-install default per ADR-022).
  const s = settings.data;
  if (s && s.easy_apply_mode === 'manual') {
    return { label: 'Mode', path: '/onboarding/mode' };
  }

  return null;
}
