import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useValidateSerpapiKey, type SerpapiValidateResult } from '../../../api/resources.js';
import {
  PrimaryButton,
  WizardFooter,
  WizardShell,
} from '../WizardShell.js';
import { usePrevStep } from '../use-wizard.js';

type UiState = 'initial' | 'validating' | 'valid' | 'invalid';

/**
 * Maps the API's machine-readable reason to user-facing copy.
 * The `.` in the test regex `/we couldn.t verify/i` matches any char, so
 * both a curly apostrophe (U+2019) and straight (U+0027) work — we use
 * straight to match the rest of the codebase (see ConnectLinkedIn.tsx).
 */
function reasonToMessage(res: SerpapiValidateResult): string {
  if (res.reason === 'auth_failed') {
    return "We couldn't verify that key. Double-check it in your SerpAPI dashboard and try again.";
  }
  if (res.reason === 'rate_limited') {
    return "Your SerpAPI quota is exhausted. Upgrade your plan or wait until it resets, then try again.";
  }
  return res.detail ?? 'Validation failed. Please check the key and try again.';
}

export function GoogleJobs(): JSX.Element {
  const navigate = useNavigate();
  const prev = usePrevStep();
  const validate = useValidateSerpapiKey();

  const [key, setKey] = useState('');
  const [ui, setUi] = useState<UiState>('initial');
  const [error, setError] = useState<string | null>(null);

  // Auto-advance to preferences once the key is confirmed valid (1s delay so
  // the success state is visible briefly — same pattern as ConnectLinkedIn).
  useEffect(() => {
    if (ui === 'valid') {
      const t = setTimeout(() => navigate('/onboarding/preferences'), 1000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [ui, navigate]);

  function handleEnable() {
    setUi('validating');
    setError(null);
    validate
      .mutate(key)
      .then((res) => {
        if (res.ok) {
          setUi('valid');
        } else {
          setError(reasonToMessage(res));
          setUi('invalid');
        }
      })
      .catch(() => {
        setError('Validation failed. Please check the key and try again.');
        setUi('invalid');
      });
  }

  const isValidating = ui === 'validating';

  const primary =
    ui === 'valid' ? (
      <PrimaryButton disabled>✓ Connected</PrimaryButton>
    ) : (
      <PrimaryButton onClick={handleEnable} disabled={isValidating || key.trim() === ''}>
        {isValidating ? 'Validating…' : 'Enable Google Jobs'}
      </PrimaryButton>
    );

  return (
    <WizardShell
      step="google-jobs"
      title="Google Jobs (Optional)"
      subtitle="Paste a SerpAPI key to let Vina search Google Jobs. Leave it blank and skip if you don't need this source — you can add it later from Settings."
      footer={
        <WizardFooter
          onBack={() => prev('google-jobs')}
          onSkip={{
            label: 'Skip for now',
            onClick: () => navigate('/onboarding/preferences'),
            disabled: isValidating,
          }}
          primary={primary}
        />
      }
    >
      <div className="space-y-4">
        <label className="block text-sm font-medium text-ink-primary" htmlFor="serpapi-key">
          SerpAPI key
        </label>
        <input
          id="serpapi-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          disabled={isValidating || ui === 'valid'}
          placeholder="sk-…"
          className="w-full rounded-md border border-border-default bg-surface-raised px-3 py-2 text-sm text-ink-primary placeholder-ink-muted focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
        />

        {ui === 'invalid' && error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}

        {ui === 'valid' && (
          <p className="text-sm text-success">✓ Key verified. Moving on…</p>
        )}
      </div>
    </WizardShell>
  );
}
