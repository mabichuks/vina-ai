/**
 * Empty page stubs (PRD-096). Each renders just a heading so navigation
 * works end-to-end. Real content lands per phase.
 */

interface PageProps {
  title: string;
  hint?: string;
}

function Page({ title, hint }: PageProps): JSX.Element {
  // Page titles per docs/theme.md §3: Fraunces, 3xl, display weight, tight tracking.
  return (
    <section>
      <h1 className="font-display text-3xl font-headline tracking-tight text-ink-primary">
        {title}
      </h1>
      {hint && <p className="mt-2 text-sm text-ink-secondary">{hint}</p>}
    </section>
  );
}

export default function Dashboard(): JSX.Element {
  return <Page title="Dashboard" hint="Stat cards and activity timeline land in Phase 22." />;
}

export function Jobs(): JSX.Element {
  return <Page title="Jobs" hint="Discovered listings appear here once the scheduler runs." />;
}

export function Applications(): JSX.Element {
  return <Page title="Applications" hint="Submitted and in-flight applications." />;
}

export function ReadyToApply(): JSX.Element {
  return <Page title="Ready to Apply" hint="Manual-apply jobs with tailored CVs waiting on you." />;
}

export function Alerts(): JSX.Element {
  return <Page title="Alerts" hint="Things needing your attention." />;
}

export function Chat(): JSX.Element {
  return <Page title="Chat" hint="Conversational interface to Vina." />;
}

export function Profile(): JSX.Element {
  return <Page title="Profile" hint="Identity, CVs, cover letters, saved answers." />;
}

export function Settings(): JSX.Element {
  return <Page title="Settings" hint="Mode, schedule, LLM provider, sources. Lands in Phase 22." />;
}

export function OnboardingPlaceholder(): JSX.Element {
  return (
    <Page
      title="Onboarding"
      hint="The 10-step wizard lands in Phase 8. For now this is a placeholder."
    />
  );
}

export function NotFound(): JSX.Element {
  return <Page title="Not found" hint="The page you're looking for does not exist." />;
}
