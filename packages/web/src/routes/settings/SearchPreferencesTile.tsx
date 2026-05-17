import { useState } from 'react';
import type { SearchPreferences } from '@vina/shared';
import { useSavePreferences, useSearchPreferences } from '../../api/resources.js';
import { useUiStore } from '../../store/ui-store.js';
import { Button } from '../../components/ui/button.js';

const WORK_MODELS = ['remote', 'hybrid', 'onsite'] as const;
type WorkModel = (typeof WORK_MODELS)[number];

/**
 * Post-onboarding editor for the user's search preferences. Mirrors the
 * onboarding `Preferences` step but with a single Save button — no wizard
 * navigation. Driven by the same `useSavePreferences` mutation so changes
 * propagate to the next search run immediately (the search handler reads
 * `getOrInitSearchPreferences` on each task).
 */
export function SearchPreferencesTile(): JSX.Element {
  const { data, isLoading } = useSearchPreferences();
  return (
    <section
      id="preferences"
      className="rounded-lg border border-border-subtle bg-surface-raised p-4"
    >
      <h2 className="font-display text-xl font-headline tracking-tight text-ink-primary">
        Search preferences
      </h2>
      <p className="mt-1 text-sm text-ink-secondary">
        Keywords are the AND-set Vina sends to job-board search. Fewer, broader
        terms yield more results; long lists narrow the result set to nothing.
      </p>
      {isLoading ? (
        <p className="mt-4 text-sm text-ink-muted">Loading…</p>
      ) : (
        <PreferencesForm key={data?.updated_at ?? 'empty'} initial={data} />
      )}
    </section>
  );
}

function PreferencesForm({ initial }: { initial: SearchPreferences | null }): JSX.Element {
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

  // Parent uses `key={data?.updated_at ?? 'empty'}` to remount the form on
  // server refresh, so we don't need a syncing effect — initial state from
  // `initial` is always fresh on mount.

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

  const submit = async (): Promise<void> => {
    try {
      await save.mutate({
        description: description.trim(),
        keywords,
        locations,
        work_models: workModels,
        score_threshold: scoreThreshold,
      });
      pushToast({ kind: 'info', message: 'Search preferences saved.' });
    } catch (err) {
      pushToast({ kind: 'error', message: (err as Error).message });
    }
  };

  return (
    <div className="mt-4 space-y-5">
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
        helper="Used for Google Jobs and LinkedIn search. Best results from 2–3 broad terms."
      />
      <ChipField
        label="Locations"
        items={locations}
        input={locationsInput}
        setInput={setLocationsInput}
        onAdd={() => addChip('locations')}
        onRemove={(v) => removeChip('locations', v)}
        helper="First location is used as the search filter."
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
                  setWorkModels(
                    active ? workModels.filter((w) => w !== wm) : [...workModels, wm],
                  )
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

      <div>
        <Button onClick={() => void submit()} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save preferences'}
        </Button>
      </div>
    </div>
  );
}

interface ChipFieldProps {
  label: string;
  items: string[];
  input: string;
  setInput: (v: string) => void;
  onAdd: () => void;
  onRemove: (v: string) => void;
  helper?: string;
}

function ChipField({
  label,
  items,
  input,
  setInput,
  onAdd,
  onRemove,
  helper,
}: ChipFieldProps): JSX.Element {
  return (
    <div>
      <span className="font-mono text-2xs uppercase tracking-wide text-ink-secondary">{label}</span>
      {helper && <p className="mt-1 text-xs text-ink-muted">{helper}</p>}
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
