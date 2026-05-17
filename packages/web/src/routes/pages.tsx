/**
 * Empty page stubs (PRD-096). Each renders just a heading so navigation
 * works end-to-end. Real content lands per phase.
 */

import { Link } from 'react-router-dom';
import {
  tailoredCvUrl,
  useApplications,
  useJobs,
  useLinkedInStatus,
} from '../api/resources.js';
import { downloadAuthed } from '../api/client.js';
import { SearchActivityPanel } from '../components/search/SearchActivityPanel.js';
import { SearchNowButton } from '../components/search/SearchNowButton.js';
import { Button } from '../components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu.js';
import { useUiStore } from '../store/ui-store.js';

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);

function DashboardCvDownload({
  jobTitle,
  company,
  appId,
}: {
  jobTitle: string | undefined;
  company: string | undefined;
  appId: string;
}): JSX.Element {
  const pushToast = useUiStore((s) => s.pushToast);
  const base = `${safeName(company ?? 'job')}-${safeName(jobTitle ?? 'tailored')}-cv`;
  const downloadFormat = async (format: 'docx' | 'pdf'): Promise<void> => {
    try {
      await downloadAuthed(`${tailoredCvUrl(appId)}?format=${format}`, `${base}.${format}`);
    } catch (err) {
      pushToast({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="rounded-md border border-border-subtle bg-surface-raised px-3 py-1 text-xs text-ink-primary hover:bg-surface-base"
        >
          CV
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={() => void downloadFormat('docx')}>
          Download .docx
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void downloadFormat('pdf')}>
          Download .pdf
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
  const ready = useApplications({ status: 'ready_for_manual_apply', pageSize: 3 });
  const readyJobIds = ready.data.map((a) => a.job_id);
  const readyJobs = useJobs({ page_size: 100 });
  const readyJobMap = new Map(readyJobs.data.map((j) => [j.id, j]));

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
      {ready.data.length > 0 && (
        <section className="rounded-lg border border-border-subtle bg-surface-raised p-4">
          <header className="flex items-center justify-between">
            <h2 className="font-display text-xl font-headline tracking-tight text-ink-primary">
              Ready to apply
            </h2>
            <Link to="/ready" className="text-sm text-ink-primary underline hover:no-underline">
              View all ({ready.data.length})
            </Link>
          </header>
          <ul className="mt-3 space-y-2 text-sm">
            {readyJobIds.slice(0, 3).map((jobId, i) => {
              const job = readyJobMap.get(jobId);
              const app = ready.data[i]!;
              return (
                <li
                  key={app.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-border-subtle bg-surface-sunken px-3 py-2"
                >
                  <div className="min-w-0">
                    <span className="block truncate text-ink-primary">
                      {job?.title ?? 'Job'} · {job?.company ?? ''}
                    </span>
                    <span className="text-xs text-ink-muted">
                      Tailored CV ready
                      {app.tailored_cover_letter_path ? ' · cover letter ready' : ''}
                    </span>
                  </div>
                  <DashboardCvDownload jobTitle={job?.title} company={job?.company} appId={app.id} />
                </li>
              );
            })}
          </ul>
        </section>
      )}
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
