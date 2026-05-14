import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { firstIncompleteStep, STEPS, useWizardCompletion, type StepId } from './use-wizard.js';

const Welcome = lazy(() => import('./steps/Welcome.js').then((m) => ({ default: m.Welcome })));
const Profile = lazy(() => import('./steps/Profile.js').then((m) => ({ default: m.Profile })));
const Cv = lazy(() => import('./steps/Cv.js').then((m) => ({ default: m.Cv })));
const LlmProvider = lazy(() =>
  import('./steps/LlmProvider.js').then((m) => ({ default: m.LlmProvider })),
);
const Preferences = lazy(() =>
  import('./steps/Preferences.js').then((m) => ({ default: m.Preferences })),
);
const Schedule = lazy(() => import('./steps/Schedule.js').then((m) => ({ default: m.Schedule })));
const ConnectLinkedIn = lazy(() =>
  import('./steps/ConnectLinkedIn.js').then((m) => ({ default: m.ConnectLinkedIn })),
);
const Done = lazy(() => import('./steps/Done.js').then((m) => ({ default: m.Done })));

function StepFallback(): JSX.Element {
  return <div className="p-12 text-sm text-ink-secondary">Loading step…</div>;
}

/**
 * Resume guard: when the user lands at `/onboarding` (no step), we redirect
 * to either Welcome (fresh) or the first incomplete required step (resume).
 * Server is the source of truth — see `useWizardCompletion` (REC 1).
 */
function OnboardingResume(): JSX.Element {
  const { flags, isLoading } = useWizardCompletion();
  if (isLoading) return <StepFallback />;
  if (!flags) return <StepFallback />;

  const anyDone =
    flags.profile || flags['llm-provider'] || flags.cv || flags['connect-linkedin'];
  const target: StepId = anyDone ? firstIncompleteStep(flags) : 'welcome';
  return <Navigate to={`/onboarding/${target}`} replace />;
}

function StepGuard({ children, step }: { children: JSX.Element; step: StepId }): JSX.Element {
  const location = useLocation();
  if (!STEPS.includes(step)) {
    return <Navigate to="/onboarding" replace state={{ from: location }} />;
  }
  return children;
}

export function OnboardingRouter(): JSX.Element {
  return (
    <Suspense fallback={<StepFallback />}>
      <Routes>
        <Route index element={<OnboardingResume />} />
        <Route
          path="welcome"
          element={
            <StepGuard step="welcome">
              <Welcome />
            </StepGuard>
          }
        />
        <Route
          path="profile"
          element={
            <StepGuard step="profile">
              <Profile />
            </StepGuard>
          }
        />
        <Route
          path="cv"
          element={
            <StepGuard step="cv">
              <Cv />
            </StepGuard>
          }
        />
        <Route
          path="llm-provider"
          element={
            <StepGuard step="llm-provider">
              <LlmProvider />
            </StepGuard>
          }
        />
        <Route
          path="preferences"
          element={
            <StepGuard step="preferences">
              <Preferences />
            </StepGuard>
          }
        />
        <Route
          path="schedule"
          element={
            <StepGuard step="schedule">
              <Schedule />
            </StepGuard>
          }
        />
        <Route
          path="connect-linkedin"
          element={
            <StepGuard step="connect-linkedin">
              <ConnectLinkedIn />
            </StepGuard>
          }
        />
        <Route
          path="done"
          element={
            <StepGuard step="done">
              <Done />
            </StepGuard>
          }
        />
        <Route path="*" element={<Navigate to="/onboarding" replace />} />
      </Routes>
    </Suspense>
  );
}
