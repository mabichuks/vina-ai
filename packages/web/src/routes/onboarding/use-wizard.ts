import { useNavigate } from 'react-router-dom';
import { useCvs, useLlmProviders, useProfile, useSites } from '../../api/resources.js';

/**
 * Step IDs in PRD order. The path under /onboarding is `/${id}`.
 */
export const STEPS = [
  'welcome',
  'profile',
  'llm-provider',
  'cv',
  'cover-letter',
  'preferences',
  'sources',
  'schedule',
  'mode',
  'done',
] as const;
export type StepId = (typeof STEPS)[number];

/**
 * Steps that gate `onboarded === true` (per PRD-050). The wizard cannot be
 * "finished" until each one has the underlying resource in place. The other
 * steps are optional and skippable (REC 3).
 */
export const REQUIRED_STEPS: ReadonlySet<StepId> = new Set<StepId>([
  'profile',
  'llm-provider',
  'cv',
  'sources',
]);

export const STEP_LABELS: Record<StepId, string> = {
  welcome: 'Welcome',
  profile: 'Profile',
  'llm-provider': 'LLM Provider',
  cv: 'CV',
  'cover-letter': 'Cover letter',
  preferences: 'Search preferences',
  sources: 'Sources',
  schedule: 'Schedule',
  mode: 'Mode',
  done: 'Done',
};

interface CompletionFlags {
  profile: boolean;
  'llm-provider': boolean;
  cv: boolean;
  sources: boolean;
}

export function useWizardCompletion(): {
  flags: CompletionFlags | null;
  isLoading: boolean;
  allRequiredDone: boolean;
} {
  const profile = useProfile();
  const providers = useLlmProviders();
  const cvs = useCvs();
  const sites = useSites();

  const isLoading = profile.isLoading || providers.isLoading || cvs.isLoading || sites.isLoading;
  if (isLoading) return { flags: null, isLoading: true, allRequiredDone: false };

  const flags: CompletionFlags = {
    profile: profile.data !== null,
    'llm-provider': providers.data.length > 0,
    cv: cvs.data.length > 0,
    sources: sites.data.some((s) => s.enabled),
  };
  const allRequiredDone = flags.profile && flags['llm-provider'] && flags.cv && flags.sources;
  return { flags, isLoading: false, allRequiredDone };
}

/**
 * Resume rule: if the user lands on `/onboarding` with no step, route them
 * to the first incomplete required step computed from server state. If all
 * required steps are done they go to `/done`. localStorage is intentionally
 * NOT consulted here — the server is the source of truth (REC 1).
 */
export function firstIncompleteStep(flags: CompletionFlags): Exclude<StepId, 'welcome'> {
  if (!flags.profile) return 'profile';
  if (!flags['llm-provider']) return 'llm-provider';
  if (!flags.cv) return 'cv';
  if (!flags.sources) return 'sources';
  return 'done';
}

export function useNextStep(): (current: StepId) => void {
  const navigate = useNavigate();
  return (current: StepId): void => {
    const idx = STEPS.indexOf(current);
    if (idx === -1 || idx === STEPS.length - 1) return;
    // react-router v7 navigate is async; we don't await — the click handler
    // returns immediately and React Router handles transition asynchronously.
    void navigate(`/onboarding/${STEPS[idx + 1]}`);
  };
}

export function usePrevStep(): (current: StepId) => void {
  const navigate = useNavigate();
  return (current: StepId): void => {
    const idx = STEPS.indexOf(current);
    if (idx <= 0) return;
    void navigate(`/onboarding/${STEPS[idx - 1]}`);
  };
}
