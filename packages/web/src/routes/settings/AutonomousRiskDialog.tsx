import { Button } from '../../components/ui/button.js';

interface Props {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function AutonomousRiskDialog({
  open,
  onConfirm,
  onCancel,
}: Props): JSX.Element | null {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-w-lg rounded-lg border border-border-subtle bg-surface-raised p-6 shadow-lg">
        <h3 className="font-display text-lg font-headline text-ink-primary">
          Risks of autonomous mode
        </h3>
        <ul className="mt-3 space-y-2 text-sm text-ink-secondary">
          <li>
            Easy Apply submissions are <strong>irreversible</strong>. Vina
            submits applications on your behalf when a job scores above your
            threshold and all gates pass.
          </li>
          <li>
            Vina <strong>never guesses</strong> answers. If a screening
            question has no literal answer in your profile or saved answers,
            Vina pauses the application and alerts you. Previously saved
            answers are reused — review them in the Saved Answers tile.
          </li>
          <li>
            EEO / demographic questions are always skipped and require you to
            answer manually.
          </li>
          <li>
            Vina caps daily applies, throttles velocity between attempts, and
            auto-pauses after consecutive failures. Tune the limits below.
          </li>
          <li>
            High-volume automation may trigger LinkedIn account flags. Keep
            the cap low until you trust the flow.
          </li>
        </ul>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>I understand — enable autonomous</Button>
        </div>
      </div>
    </div>
  );
}
