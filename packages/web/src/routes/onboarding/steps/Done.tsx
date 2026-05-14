import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { PrimaryButton, WizardFooter, WizardShell } from '../WizardShell.js';
import { useWizardCompletion } from '../use-wizard.js';

export function Done(): JSX.Element {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { allRequiredDone } = useWizardCompletion();

  const onFindJobs = (): void => {
    // Refresh bootstrap so the BootstrapGate sees `onboarded: true` and routes
    // future visits past the wizard. Land on /jobs (not /) — the user just
    // connected LinkedIn, the next thing they want is the Search-now button.
    void qc.invalidateQueries({ queryKey: ['bootstrap'] });
    void navigate('/jobs');
  };

  return (
    <WizardShell
      step="done"
      title="You're all set"
      subtitle={
        allRequiredDone
          ? "Vina has everything it needs. Click below to open Jobs and run your first search."
          : 'A few required pieces are still missing. Use the Back button to finish them up.'
      }
      footer={
        <WizardFooter
          primary={
            <PrimaryButton onClick={onFindJobs} disabled={!allRequiredDone}>
              Find jobs
            </PrimaryButton>
          }
        />
      }
    >
      <div className="space-y-3 text-sm text-ink-secondary">
        <p>What happens next:</p>
        <ul className="list-inside list-disc space-y-1">
          <li>
            On the Jobs page, click <span className="font-medium text-ink-primary">Search now</span>{' '}
            to discover listings on demand — or wait for the scheduler.
          </li>
          <li>Matches above your score threshold appear in the New tab.</li>
          <li>
            Click <span className="font-medium text-ink-primary">Apply on LinkedIn</span> to open the
            listing, then <span className="font-medium text-ink-primary">Mark applied</span> back in
            Vina to keep your worklist tidy.
          </li>
        </ul>
      </div>
    </WizardShell>
  );
}
