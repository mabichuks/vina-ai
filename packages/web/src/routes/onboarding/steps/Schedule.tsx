import { useState } from 'react';
import { useSaveSchedule, useSchedules, type ScheduleRow } from '../../../api/resources.js';
import { useUiStore } from '../../../store/ui-store.js';
import { PrimaryButton, WizardFooter, WizardShell } from '../WizardShell.js';
import { useNextStep, usePrevStep } from '../use-wizard.js';

const SKIP_DEFAULT = '0 9 * * *';

const PRESETS: { label: string; cron: string }[] = [
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Every 12 hours', cron: '0 */12 * * *' },
  { label: 'Daily at 9am', cron: '0 9 * * *' },
  { label: 'Custom', cron: 'custom' },
];

export function Schedule(): JSX.Element {
  const { data: schedules, isLoading } = useSchedules();
  if (isLoading) return <ScheduleForm key="loading" initial={null} disabled />;
  const existing = schedules[0] ?? null;
  return <ScheduleForm key={existing?.id ?? 'new'} initial={existing} />;
}

function ScheduleForm({
  initial,
  disabled,
}: {
  initial: ScheduleRow | null;
  disabled?: boolean;
}): JSX.Element {
  const next = useNextStep();
  const prev = usePrevStep();
  const save = useSaveSchedule();
  const pushToast = useUiStore((s) => s.pushToast);

  const initialMatch = initial
    ? PRESETS.find((p) => p.cron === initial.cron_expression)
    : undefined;
  const [preset, setPreset] = useState<string>(
    initialMatch?.cron ?? (initial ? 'custom' : '0 9 * * *'),
  );
  const [custom, setCustom] = useState(initial && !initialMatch ? initial.cron_expression : '');

  const submit = async (skip: boolean): Promise<void> => {
    const cron = skip ? SKIP_DEFAULT : preset === 'custom' ? custom.trim() : preset;
    if (!cron) {
      pushToast({ kind: 'error', message: 'Cron expression is empty.' });
      return;
    }
    try {
      await save.mutate(cron, initial);
      next('schedule');
    } catch (err) {
      pushToast({ kind: 'error', message: (err as Error).message });
    }
  };

  return (
    <WizardShell
      step="schedule"
      title="How often should Vina search?"
      subtitle="Each tick triggers a fresh job search across the enabled sources. You can change this later."
      footer={
        <WizardFooter
          onBack={() => prev('schedule')}
          onSkip={{
            label: 'Skip for now',
            onClick: () => void submit(true),
            disabled: save.isPending,
          }}
          primary={
            <PrimaryButton onClick={() => void submit(false)} disabled={save.isPending || disabled}>
              {save.isPending ? 'Saving…' : 'Next'}
            </PrimaryButton>
          }
        />
      }
    >
      <div className="space-y-3">
        {PRESETS.map((p) => (
          <button
            key={p.cron}
            type="button"
            onClick={() => setPreset(p.cron)}
            className={[
              'block w-full rounded-md border px-4 py-3 text-left transition',
              preset === p.cron
                ? 'border-accent bg-accent-soft text-ink-primary shadow-accent'
                : 'border-border-subtle bg-surface-raised hover:border-border-default',
            ].join(' ')}
          >
            <div className="font-medium">{p.label}</div>
            {p.cron !== 'custom' && (
              <div className="font-mono text-2xs text-ink-muted">{p.cron}</div>
            )}
          </button>
        ))}
        {preset === 'custom' && (
          <input
            type="text"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="Standard 5-field cron"
            className="block w-full rounded-md border border-border-default bg-surface-sunken px-3 py-2 font-mono text-sm text-ink-primary outline-none focus:border-accent focus:shadow-accent"
          />
        )}
      </div>
    </WizardShell>
  );
}
