import { useNavigate } from 'react-router-dom';
import { PrimaryButton, WizardFooter, WizardShell } from '../WizardShell.js';

export function Welcome(): JSX.Element {
  const navigate = useNavigate();
  return (
    <WizardShell
      step="welcome"
      title="Welcome to Vina"
      subtitle="A small, careful machine that handles the noisy parts of job hunting — searching, matching, tailoring, applying — so you can focus on the conversations that matter."
      footer={
        <WizardFooter
          primary={
            <PrimaryButton onClick={() => navigate('/onboarding/profile')}>
              Get started
            </PrimaryButton>
          }
        />
      }
    >
      <div className="space-y-4 text-ink-secondary">
        <p>The next few steps set up the bare minimum:</p>
        <ul className="list-inside list-disc space-y-1 text-sm">
          <li>Who you are (name + email)</li>
          <li>An LLM provider — your key, used for matching and tailoring</li>
          <li>A CV to start from</li>
          <li>At least one job source (LinkedIn, Indeed, or Google Jobs)</li>
        </ul>
        <p className="text-sm">
          The remaining steps — cover letter, search preferences, schedule, mode — can be customised
          now or later from Settings.
        </p>
      </div>
    </WizardShell>
  );
}
