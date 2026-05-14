/**
 * Empty page stubs (PRD-096). Each renders just a heading so navigation
 * works end-to-end. Real content lands per phase.
 */

import { Link } from 'react-router-dom';
import { useJobs, useLinkedInStatus } from '../api/resources.js';
import { SearchActivityPanel } from '../components/search/SearchActivityPanel.js';
import { SearchNowButton } from '../components/search/SearchNowButton.js';
import { Button } from '../components/ui/button.js';

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

function dashboardTagline(connected: boolean, hasJobs: boolean): string {
  if (!connected) return 'Connect LinkedIn to start finding jobs.';
  if (hasJobs) return 'Latest scored jobs are waiting in your worklist.';
  return 'No jobs yet — run a search to find some.';
}

export default function Dashboard(): JSX.Element {
  const linkedin = useLinkedInStatus({ pollMs: 5000 });
  const jobs = useJobs({ status: 'scored', page_size: 1 });

  return (
    <section className="space-y-4">
      <h1 className="font-display text-3xl font-headline tracking-tight text-ink-primary">
        Dashboard
      </h1>
      <p className="text-sm text-ink-secondary">
        {dashboardTagline(linkedin.data?.connected ?? false, jobs.data.length > 0)}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <SearchNowButton />
        <Button asChild variant="outline">
          <Link to="/jobs">View jobs</Link>
        </Button>
        {!linkedin.data?.connected && (
          <Button asChild variant="ghost">
            <Link to="/settings#sites">Connect LinkedIn</Link>
          </Button>
        )}
      </div>
      <SearchActivityPanel />
    </section>
  );
}

export function Applications(): JSX.Element {
  return <Page title="Applications" hint="Submitted and in-flight applications." />;
}

export function Chat(): JSX.Element {
  return <Page title="Chat" hint="Conversational interface to Vina." />;
}

export function Profile(): JSX.Element {
  return <Page title="Profile" hint="Identity, CVs, cover letters, saved answers." />;
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
