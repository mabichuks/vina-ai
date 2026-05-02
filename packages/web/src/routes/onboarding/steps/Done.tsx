import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { PrimaryButton, WizardFooter, WizardShell } from '../WizardShell.js';
import { useWizardCompletion } from '../use-wizard.js';

export function Done(): JSX.Element {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { allRequiredDone } = useWizardCompletion();

  const onOpenDashboard = (): void => {
    // Refresh bootstrap so the BootstrapGate sees `onboarded: true` and routes
    // future visits straight to `/`.
    void qc.invalidateQueries({ queryKey: ['bootstrap'] });
    void navigate('/');
  };

  return (
    <WizardShell
      step="done"
      title="You're all set"
      subtitle={
        allRequiredDone
          ? 'Vina has everything it needs to start finding and applying. The Topbar will nudge you if any optional pieces (cover letter, search preferences, schedule, mode) are still at their defaults.'
          : 'A few required pieces are still missing. Use the Back button to finish them up.'
      }
      footer={
        <WizardFooter
          primary={
            <PrimaryButton onClick={onOpenDashboard} disabled={!allRequiredDone}>
              Open dashboard
            </PrimaryButton>
          }
        />
      }
    >
      <div className="space-y-3 text-sm text-ink-secondary">
        <p>What happens next:</p>
        <ul className="list-inside list-disc space-y-1">
          <li>The scheduler runs your first job search</li>
          <li>Matches above your score threshold get queued</li>
          <li>
            <span className="font-medium text-ink-primary">Auto-apply</span> jobs flow through
            tailoring → submission
          </li>
          <li>
            <span className="font-medium text-ink-primary">Manual-apply</span> jobs land in the
            &ldquo;Ready to Apply&rdquo; tab with a tailored CV waiting for you
          </li>
        </ul>
      </div>
    </WizardShell>
  );
}
