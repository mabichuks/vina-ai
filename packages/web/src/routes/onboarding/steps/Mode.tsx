import { useState } from 'react';
import type { ApprovalSetting, OperatingMode, Settings } from '@vina/shared';
import { useSettings, useUpdateSettings } from '../../../api/resources.js';
import { useUiStore } from '../../../store/ui-store.js';
import { PrimaryButton, WizardFooter, WizardShell } from '../WizardShell.js';
import { useNextStep, usePrevStep } from '../use-wizard.js';

const SKIP_DEFAULT_MODE: OperatingMode = 'supervised';
const SKIP_DEFAULT_APPROVAL: ApprovalSetting = 'review-first';

export function Mode(): JSX.Element {
  const { data: settings, isLoading } = useSettings();
  if (isLoading) return <ModeForm key="loading" initial={null} disabled />;
  return <ModeForm key={settings?.updated_at ?? 'new'} initial={settings} />;
}

function ModeForm({
  initial,
  disabled,
}: {
  initial: Settings | null;
  disabled?: boolean;
}): JSX.Element {
  const next = useNextStep();
  const prev = usePrevStep();
  const update = useUpdateSettings();
  const pushToast = useUiStore((s) => s.pushToast);

  const [mode, setMode] = useState<OperatingMode>(initial?.mode ?? 'supervised');
  const [approval, setApproval] = useState<ApprovalSetting>(initial?.approval ?? 'review-first');

  const submit = async (skip: boolean): Promise<void> => {
    try {
      await update.mutate(
        skip ? { mode: SKIP_DEFAULT_MODE, approval: SKIP_DEFAULT_APPROVAL } : { mode, approval },
      );
      next('mode');
    } catch (err) {
      pushToast({ kind: 'error', message: (err as Error).message });
    }
  };

  return (
    <WizardShell
      step="mode"
      title="How should Vina behave?"
      subtitle="You can change either of these from Settings later."
      footer={
        <WizardFooter
          onBack={() => prev('mode')}
          onSkip={{
            label: 'Skip for now',
            onClick: () => void submit(true),
            disabled: update.isPending,
          }}
          primary={
            <PrimaryButton
              onClick={() => void submit(false)}
              disabled={update.isPending || disabled}
            >
              {update.isPending ? 'Saving…' : 'Next'}
            </PrimaryButton>
          }
        />
      }
    >
      <div className="space-y-6">
        <div>
          <h2 className="font-mono text-2xs uppercase tracking-wide text-ink-secondary">Mode</h2>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <RadioCard
              active={mode === 'supervised'}
              onClick={() => setMode('supervised')}
              label="Supervised"
              blurb="Vina suggests; you confirm each step."
            />
            <RadioCard
              active={mode === 'autonomous'}
              onClick={() => setMode('autonomous')}
              label="Autonomous"
              blurb="Vina picks jobs to apply to within your preferences."
            />
          </div>
        </div>

        <div>
          <h2 className="font-mono text-2xs uppercase tracking-wide text-ink-secondary">
            Application approval
          </h2>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <RadioCard
              active={approval === 'review-first'}
              onClick={() => setApproval('review-first')}
              label="Review first"
              blurb="See the tailored CV before submission."
            />
            <RadioCard
              active={approval === 'auto-apply'}
              onClick={() => setApproval('auto-apply')}
              label="Auto-apply"
              blurb="Vina submits as soon as the CV is ready."
            />
          </div>
        </div>
      </div>
    </WizardShell>
  );
}

interface RadioCardProps {
  active: boolean;
  onClick: () => void;
  label: string;
  blurb: string;
}

function RadioCard({ active, onClick, label, blurb }: RadioCardProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'rounded-md border px-4 py-3 text-left transition',
        active
          ? 'border-accent bg-accent-soft shadow-accent'
          : 'border-border-subtle bg-surface-raised hover:border-border-default',
      ].join(' ')}
    >
      <div className="font-medium text-ink-primary">{label}</div>
      <div className="text-sm text-ink-secondary">{blurb}</div>
    </button>
  );
}
