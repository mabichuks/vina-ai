import { useState } from 'react';
import type { SearchPreferences } from '@vina/shared';
import { useSavePreferences, useSearchPreferences } from '../../../api/resources.js';
import { useUiStore } from '../../../store/ui-store.js';
import { PrimaryButton, WizardFooter, WizardShell } from '../WizardShell.js';
import { useNextStep, usePrevStep } from '../use-wizard.js';

const SKIP_DEFAULT = {
  description: '',
  keywords: [] as string[],
  locations: [] as string[],
  work_models: [] as ('remote' | 'hybrid' | 'onsite')[],
  seniority: [] as never[],
  excluded_companies: [] as string[],
  score_threshold: 70,
};

const WORK_MODELS = ['remote', 'hybrid', 'onsite'] as const;
type WorkModel = (typeof WORK_MODELS)[number];

export function Preferences(): JSX.Element {
  const { data: existing, isLoading } = useSearchPreferences();
  if (isLoading) return <PreferencesForm key="loading" initial={null} disabled />;
  return <PreferencesForm key={existing?.updated_at ?? 'new'} initial={existing} />;
}

function PreferencesForm({
  initial,
  disabled,
}: {
  initial: SearchPreferences | null;
  disabled?: boolean;
}): JSX.Element {
  const next = useNextStep();
  const prev = usePrevStep();
  const save = useSavePreferences();
  const pushToast = useUiStore((s) => s.pushToast);

  const [description, setDescription] = useState(initial?.description ?? '');
  const [keywords, setKeywords] = useState<string[]>(initial?.keywords ?? []);
  const [keywordsInput, setKeywordsInput] = useState('');
  const [locations, setLocations] = useState<string[]>(initial?.locations ?? []);
  const [locationsInput, setLocationsInput] = useState('');
  const [workModels, setWorkModels] = useState<WorkModel[]>(
    (initial?.work_models as WorkModel[] | undefined) ?? [],
  );
  const [scoreThreshold, setScoreThreshold] = useState(initial?.score_threshold ?? 70);

  const submit = async (skip: boolean): Promise<void> => {
    try {
      if (skip) {
        await save.mutate(SKIP_DEFAULT);
      } else {
        await save.mutate({
          description: description.trim(),
          keywords,
          locations,
          work_models: workModels,
          score_threshold: scoreThreshold,
        });
      }
      next('preferences');
    } catch (err) {
      pushToast({ kind: 'error', message: (err as Error).message });
    }
  };

  const addChip = (kind: 'keywords' | 'locations'): void => {
    const setter = kind === 'keywords' ? setKeywords : setLocations;
    const input = kind === 'keywords' ? keywordsInput : locationsInput;
    const inputSetter = kind === 'keywords' ? setKeywordsInput : setLocationsInput;
    const list = kind === 'keywords' ? keywords : locations;
    const trimmed = input.trim();
    if (!trimmed || list.includes(trimmed)) return;
    setter([...list, trimmed]);
    inputSetter('');
  };

  const removeChip = (kind: 'keywords' | 'locations', item: string): void => {
    if (kind === 'keywords') setKeywords(keywords.filter((k) => k !== item));
    else setLocations(locations.filter((l) => l !== item));
  };

  return (
    <WizardShell
      step="preferences"
      title="What jobs are you looking for?"
      subtitle="Vina uses this to score and filter listings. You can leave it broad and refine as you see what comes back."
      footer={
        <WizardFooter
          onBack={() => prev('preferences')}
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
      <div className="space-y-6">
        <label className="block">
          <span className="font-mono text-2xs uppercase tracking-wide text-ink-secondary">
            Description
          </span>
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Senior backend roles, remote, EU-friendly timezone, payments or fintech."
            className="mt-1 block w-full rounded-md border border-border-default bg-surface-sunken px-3 py-2 text-base text-ink-primary outline-none focus:border-accent focus:shadow-accent"
          />
        </label>

        <ChipField
          label="Keywords"
          items={keywords}
          input={keywordsInput}
          setInput={setKeywordsInput}
          onAdd={() => addChip('keywords')}
          onRemove={(v) => removeChip('keywords', v)}
        />
        <ChipField
          label="Locations"
          items={locations}
          input={locationsInput}
          setInput={setLocationsInput}
          onAdd={() => addChip('locations')}
          onRemove={(v) => removeChip('locations', v)}
        />

        <div>
          <span className="font-mono text-2xs uppercase tracking-wide text-ink-secondary">
            Work model
          </span>
          <div className="mt-2 flex gap-2">
            {WORK_MODELS.map((wm) => {
              const active = workModels.includes(wm);
              return (
                <button
                  key={wm}
                  type="button"
                  onClick={() =>
                    setWorkModels(active ? workModels.filter((w) => w !== wm) : [...workModels, wm])
                  }
                  className={[
                    'rounded-pill px-3 py-1 font-mono text-2xs uppercase tracking-wide transition',
                    active
                      ? 'bg-accent text-on-accent'
                      : 'bg-surface-sunken text-ink-secondary hover:text-ink-primary',
                  ].join(' ')}
                >
                  {wm}
                </button>
              );
            })}
          </div>
        </div>

        <label className="block">
          <span className="font-mono text-2xs uppercase tracking-wide text-ink-secondary">
            Match-score threshold (only auto-apply at or above)
          </span>
          <input
            type="number"
            min={0}
            max={100}
            value={scoreThreshold}
            onChange={(e) => setScoreThreshold(Number.parseInt(e.target.value, 10) || 0)}
            className="mt-1 block w-32 rounded-md border border-border-default bg-surface-sunken px-3 py-2 text-base text-ink-primary outline-none focus:border-accent focus:shadow-accent"
          />
        </label>
      </div>
    </WizardShell>
  );
}

interface ChipFieldProps {
  label: string;
  items: string[];
  input: string;
  setInput: (v: string) => void;
  onAdd: () => void;
  onRemove: (v: string) => void;
}

function ChipField({
  label,
  items,
  input,
  setInput,
  onAdd,
  onRemove,
}: ChipFieldProps): JSX.Element {
  return (
    <div>
      <span className="font-mono text-2xs uppercase tracking-wide text-ink-secondary">{label}</span>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {items.map((item) => (
          <span
            key={item}
            className="inline-flex items-center gap-1 rounded-pill bg-surface-sunken px-2 py-0.5 font-mono text-2xs uppercase tracking-wide text-ink-primary"
          >
            {item}
            <button
              type="button"
              aria-label={`Remove ${item}`}
              className="text-ink-muted hover:text-ink-primary"
              onClick={() => onRemove(item)}
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              onAdd();
            }
          }}
          placeholder="Type and press Enter"
          className="flex-1 min-w-[140px] rounded-md border border-border-default bg-surface-sunken px-3 py-1.5 text-sm text-ink-primary outline-none focus:border-accent focus:shadow-accent"
        />
      </div>
    </div>
  );
}
