import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useCancelLinkedInConnect,
  useLinkedInStatus,
  useStartLinkedInConnect,
} from '../../../api/resources.js';
import {
  PrimaryButton,
  TextButton,
  WizardFooter,
  WizardShell,
} from '../WizardShell.js';
import { usePrevStep } from '../use-wizard.js';

type UiState = 'initial' | 'launching' | 'waiting' | 'connected' | 'timed_out' | 'error';

function inferUiState(
  status: { connected: boolean; attempting: boolean; error: string | null } | null,
  starting: boolean,
): UiState {
  if (status?.connected) return 'connected';
  if (status?.error === 'timed_out') return 'timed_out';
  if (starting) return 'launching';
  if (status?.attempting) return 'waiting';
  if (status?.error) return 'error';
  return 'initial';
}

export function ConnectLinkedIn(): JSX.Element {
  const navigate = useNavigate();
  const prev = usePrevStep();
  const status = useLinkedInStatus({ pollMs: 1500 });
  const start = useStartLinkedInConnect();
  const cancel = useCancelLinkedInConnect();

  const ui = inferUiState(status.data, start.isPending);

  useEffect(() => {
    if (ui === 'connected') {
      const t = setTimeout(() => navigate('/onboarding/done'), 1000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [ui, navigate]);

  const primary =
    ui === 'connected' ? (
      <PrimaryButton disabled>✓ Connected</PrimaryButton>
    ) : ui === 'timed_out' ? (
      <PrimaryButton onClick={() => start.mutate()} disabled={start.isPending}>
        Try again
      </PrimaryButton>
    ) : (
      <PrimaryButton
        onClick={() => start.mutate()}
        disabled={start.isPending || ui === 'waiting'}
      >
        {ui === 'waiting' ? 'Waiting for sign-in…' : 'Connect LinkedIn'}
      </PrimaryButton>
    );

  return (
    <WizardShell
      step="connect-linkedin"
      title="Connect LinkedIn"
      subtitle="Vina opens a browser window. Sign in to LinkedIn there once and we'll continue automatically — your session stays on your machine."
      footer={
        <WizardFooter
          onBack={() => prev('connect-linkedin')}
          {...(ui === 'timed_out' && {
            onSkip: {
              label: 'Skip for now (no jobs will arrive)',
              onClick: () => navigate('/onboarding/done'),
            },
          })}
          primary={primary}
        />
      }
    >
      <div className="space-y-4 text-sm text-ink-secondary">
        {ui === 'initial' && (
          <p>Click <strong>Connect LinkedIn</strong> to open a browser window.</p>
        )}
        {ui === 'launching' && <p>Opening browser…</p>}
        {ui === 'waiting' && (
          <div className="space-y-2">
            <p>Sign in to LinkedIn in the window we just opened.</p>
            <p>
              {`We'll detect when you're signed in and move on automatically. Captchas and "Verify it's you" challenges are fine — just complete them.`}
            </p>
            <TextButton onClick={() => cancel.mutate()}>Cancel</TextButton>
          </div>
        )}
        {ui === 'connected' && (
          <p className="text-success">✓ Connected to LinkedIn. Moving on…</p>
        )}
        {ui === 'timed_out' && (
          <div className="space-y-2">
            <p className="text-warning">Login is taking longer than expected.</p>
            <p>You can try again now, or skip this step and reconnect later from Settings.</p>
          </div>
        )}
        {ui === 'error' && status.data?.error && (
          <p className="text-danger">{`Couldn't connect: ${status.data.error}`}</p>
        )}
      </div>
    </WizardShell>
  );
}
