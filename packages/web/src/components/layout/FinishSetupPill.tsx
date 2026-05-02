import { useNavigate } from 'react-router-dom';
import { useUiStore } from '../../store/ui-store.js';
import { useFirstDefaultStep } from '../../bootstrap/use-finish-setup.js';

/**
 * Topbar nudge for users who skipped optional onboarding steps. Hidden when
 * every optional value has been customised, or after dismissal in the
 * current session (per PRD-095).
 */
export function FinishSetupPill(): JSX.Element | null {
  const dismissed = useUiStore((s) => s.finishSetupDismissed);
  const dismiss = useUiStore((s) => s.dismissFinishSetup);
  const navigate = useNavigate();
  const firstStep = useFirstDefaultStep();

  if (dismissed || !firstStep) return null;

  return (
    <div className="flex items-center gap-1 rounded-pill bg-warning-soft px-2 py-1 text-xs text-warning">
      <button
        type="button"
        className="font-medium hover:underline"
        onClick={() => navigate(firstStep.path)}
      >
        Finish setup ({firstStep.label})
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        className="px-1 text-warning/70 hover:text-warning"
        onClick={dismiss}
      >
        ×
      </button>
    </div>
  );
}
