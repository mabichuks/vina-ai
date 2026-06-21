import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Settings, SettingsUpdate } from '@vina/shared';
import { AutonomousRiskDialog } from './AutonomousRiskDialog.js';

async function fetchSettings(): Promise<Settings> {
  const r = await fetch('/api/settings');
  if (!r.ok) throw new Error('Failed to fetch settings');
  return (await r.json()) as Settings;
}

async function patchSettings(update: SettingsUpdate): Promise<Settings> {
  const r = await fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update),
  });
  if (!r.ok) throw new Error('Failed to update settings');
  return (await r.json()) as Settings;
}

export function EasyApplyTile(): JSX.Element {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['settings'], queryFn: fetchSettings });
  const mutate = useMutation({
    mutationFn: patchSettings,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });
  const [showRiskDialog, setShowRiskDialog] = useState(false);

  if (!data) {
    return (
      <section className="rounded-lg border border-border-subtle bg-surface-raised p-4">
        <p className="text-sm text-ink-muted">Loading…</p>
      </section>
    );
  }

  const setMode = (mode: 'autonomous' | 'manual'): void => {
    if (mode === 'autonomous' && data.easy_apply_mode !== 'autonomous') {
      setShowRiskDialog(true);
      return;
    }
    mutate.mutate({ easy_apply_mode: mode });
  };

  const patchNumber = (key: keyof SettingsUpdate, value: number): void => {
    mutate.mutate({ [key]: value } as SettingsUpdate);
  };

  return (
    <section
      id="easy-apply"
      className="rounded-lg border border-border-subtle bg-surface-raised p-4"
    >
      <header className="mb-3">
        <h2 className="font-display text-xl font-headline tracking-tight text-ink-primary">
          Easy Apply
        </h2>
      </header>

      <fieldset className="mb-4">
        <legend className="mb-2 text-sm font-medium text-ink-primary">
          Mode
        </legend>
        <label className="mr-4 inline-flex items-center gap-2 text-sm text-ink-secondary">
          <input
            type="radio"
            name="easy_apply_mode"
            value="manual"
            checked={data.easy_apply_mode === 'manual'}
            onChange={() => setMode('manual')}
          />
          Manual — only apply when I click Auto-apply
        </label>
        <label className="inline-flex items-center gap-2 text-sm text-ink-secondary">
          <input
            type="radio"
            name="easy_apply_mode"
            value="autonomous"
            checked={data.easy_apply_mode === 'autonomous'}
            onChange={() => setMode('autonomous')}
          />
          Autonomous — apply on my behalf
        </label>
      </fieldset>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <NumberField
          label="Daily Easy Apply cap"
          help="Counts successful submissions. Manual clicks count too."
          value={data.apply_daily_cap}
          min={1}
          max={100}
          onCommit={(v) => patchNumber('apply_daily_cap', v)}
        />
        <NumberField
          label="Minimum minutes between applies"
          help="Velocity throttle in minutes (0 disables)."
          value={Math.round(data.apply_min_interval_seconds / 60)}
          min={0}
          max={60}
          onCommit={(v) => patchNumber('apply_min_interval_seconds', v * 60)}
        />
        <NumberField
          label="Skip listings older than (days)"
          value={data.apply_listing_max_age_days}
          min={1}
          max={365}
          onCommit={(v) => patchNumber('apply_listing_max_age_days', v)}
        />
        <NumberField
          label="Pause after N consecutive failures"
          help="Vina flips back to manual when this is hit."
          value={data.apply_consecutive_failure_limit}
          min={1}
          max={50}
          onCommit={(v) => patchNumber('apply_consecutive_failure_limit', v)}
        />
      </div>

      <label className="mt-4 flex items-center gap-2 text-sm text-ink-secondary">
        <input
          type="checkbox"
          checked={data.autonomous_apply_dry_run}
          onChange={(e) =>
            mutate.mutate({ autonomous_apply_dry_run: e.target.checked })
          }
        />
        Dry-run — log would-be applies without submitting (recommended for the
        first week)
      </label>

      <AutonomousRiskDialog
        open={showRiskDialog}
        onCancel={() => setShowRiskDialog(false)}
        onConfirm={() => {
          setShowRiskDialog(false);
          mutate.mutate({ easy_apply_mode: 'autonomous' });
        }}
      />
    </section>
  );
}

interface NumberFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  help?: string;
  onCommit: (n: number) => void;
}

function NumberField(props: NumberFieldProps): JSX.Element {
  const [v, setV] = useState(String(props.value));
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-ink-primary">{props.label}</span>
      <input
        type="number"
        min={props.min}
        max={props.max}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          const n = Number(v);
          if (
            Number.isInteger(n) &&
            n >= props.min &&
            n <= props.max &&
            n !== props.value
          ) {
            props.onCommit(n);
          } else {
            setV(String(props.value));
          }
        }}
        className="rounded border border-border-subtle bg-surface-sunken px-2 py-1 text-ink-primary"
      />
      {props.help ? (
        <span className="text-xs text-ink-muted">{props.help}</span>
      ) : null}
    </label>
  );
}
