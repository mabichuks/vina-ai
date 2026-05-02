import { useState } from 'react';
import type { LlmProvider as LlmProviderRow, LlmProviderKind } from '@vina/shared';
import {
  useCreateLlmProvider,
  useLlmProviders,
  useUpdateSettings,
} from '../../../api/resources.js';
import { useUiStore } from '../../../store/ui-store.js';
import { PrimaryButton, WizardFooter, WizardShell } from '../WizardShell.js';
import { useNextStep, usePrevStep } from '../use-wizard.js';
import { Field } from './Profile.js';

const DEFAULT_MODELS: Record<LlmProviderKind, string> = {
  anthropic: 'claude-opus-4-7',
  openai: 'gpt-5',
  ollama: 'llama3.1:70b',
};

const KINDS: { id: LlmProviderKind; label: string; blurb: string }[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    blurb: 'Claude — strong defaults for tailoring and matching.',
  },
  { id: 'openai', label: 'OpenAI', blurb: 'GPT — broad model selection.' },
  {
    id: 'ollama',
    label: 'Ollama',
    blurb: 'Run a local model. No API key needed.',
  },
];

export function LlmProvider(): JSX.Element {
  const { data: providers, isLoading } = useLlmProviders();
  if (isLoading) return <LlmProviderForm key="loading" initial={null} disabled />;
  const existing = providers[0] ?? null;
  return <LlmProviderForm key={existing?.id ?? 'new'} initial={existing} />;
}

function LlmProviderForm({
  initial,
  disabled,
}: {
  initial: LlmProviderRow | null;
  disabled?: boolean;
}): JSX.Element {
  const next = useNextStep();
  const prev = usePrevStep();
  const create = useCreateLlmProvider();
  const updateSettings = useUpdateSettings();
  const pushToast = useUiStore((s) => s.pushToast);

  const [kind, setKind] = useState<LlmProviderKind>(initial?.kind ?? 'anthropic');
  const [model, setModel] = useState<string>(initial?.model ?? DEFAULT_MODELS.anthropic);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? 'http://localhost:11434');

  const onKindChange = (k: LlmProviderKind): void => {
    if (model === DEFAULT_MODELS[kind]) setModel(DEFAULT_MODELS[k]);
    setKind(k);
  };

  const submit = async (): Promise<void> => {
    if (kind !== 'ollama' && !apiKey.trim() && !initial) {
      pushToast({ kind: 'error', message: 'API key is required for this provider.' });
      return;
    }
    try {
      const provider = await create.mutate({
        kind,
        label: KINDS.find((k) => k.id === kind)?.label ?? kind,
        model,
        ...(kind === 'ollama' && baseUrl.trim() && { base_url: baseUrl.trim() }),
        ...(apiKey.trim() && { api_key: apiKey.trim() }),
      });
      await updateSettings.mutate({ active_llm_provider_id: provider.id });
      next('llm-provider');
    } catch (err) {
      pushToast({
        kind: 'error',
        message:
          (err as Error).message ||
          'Could not validate this provider. Check the key and try again.',
      });
    }
  };

  return (
    <WizardShell
      step="llm-provider"
      title="Pick an LLM provider"
      subtitle="Vina uses a language model to score job matches and tailor your CV. Your key stays on this machine, encrypted with the OS keychain (or a 0600 file on platforms without one)."
      footer={
        <WizardFooter
          onBack={() => prev('llm-provider')}
          primary={
            <PrimaryButton onClick={() => void submit()} disabled={create.isPending || disabled}>
              {create.isPending ? 'Validating…' : 'Validate & continue'}
            </PrimaryButton>
          }
        />
      }
    >
      <div className="space-y-3">
        {KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            onClick={() => onKindChange(k.id)}
            className={[
              'block w-full rounded-md border px-4 py-3 text-left transition',
              kind === k.id
                ? 'border-accent bg-accent-soft text-ink-primary shadow-accent'
                : 'border-border-subtle bg-surface-raised hover:border-border-default',
            ].join(' ')}
          >
            <div className="font-medium">{k.label}</div>
            <div className="text-sm text-ink-secondary">{k.blurb}</div>
          </button>
        ))}

        <div className="mt-6 space-y-4">
          <Field label="Model" value={model} onChange={setModel} required />
          {kind !== 'ollama' && (
            <Field
              label={initial ? 'API key (leave blank to keep current)' : 'API key'}
              type="password"
              value={apiKey}
              onChange={setApiKey}
            />
          )}
          {kind === 'ollama' && <Field label="Base URL" value={baseUrl} onChange={setBaseUrl} />}
        </div>
      </div>
    </WizardShell>
  );
}
