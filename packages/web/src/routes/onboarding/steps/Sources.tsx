import { useState } from 'react';
import {
  useLoginSite,
  useSettings,
  useSites,
  useToggleSite,
  useUpdateSettings,
} from '../../../api/resources.js';
import { useUiStore } from '../../../store/ui-store.js';
import { PrimaryButton, SecondaryButton, WizardFooter, WizardShell } from '../WizardShell.js';
import { useNextStep, usePrevStep } from '../use-wizard.js';

export function Sources(): JSX.Element {
  const next = useNextStep();
  const prev = usePrevStep();
  const { data: sites } = useSites();
  const { data: settings } = useSettings();
  const toggle = useToggleSite();
  const login = useLoginSite();
  const updateSettings = useUpdateSettings();
  const pushToast = useUiStore((s) => s.pushToast);

  const [serpapiKey, setSerpapiKey] = useState('');
  const [serpapiSaving, setSerpapiSaving] = useState(false);

  const linkedin = sites.find((s) => s.id === 'linkedin');
  const indeed = sites.find((s) => s.id === 'indeed');
  const google = sites.find((s) => s.id === 'google');

  const anyEnabled = sites.some((s) => s.enabled);

  const onLogin = async (id: string): Promise<void> => {
    try {
      await login.mutate(id);
      // Phase 11 will replace this with real Playwright; for now the route
      // mock-marks the session valid synchronously.
      await toggle.mutate(id, true);
    } catch (err) {
      pushToast({ kind: 'error', message: (err as Error).message });
    }
  };

  const onSaveSerpapi = async (): Promise<void> => {
    if (!serpapiKey.trim()) return;
    setSerpapiSaving(true);
    try {
      await updateSettings.mutate({ serpapi_key: serpapiKey.trim() });
      // The backend validates the key before storing; if we got here, enable Google.
      await toggle.mutate('google', true);
      setSerpapiKey('');
    } catch (err) {
      pushToast({ kind: 'error', message: (err as Error).message });
    } finally {
      setSerpapiSaving(false);
    }
  };

  return (
    <WizardShell
      step="sources"
      title="Where should Vina look?"
      subtitle="Enable at least one source. LinkedIn and Indeed use your saved browser session; Google Jobs uses a SerpAPI key."
      footer={
        <WizardFooter
          onBack={() => prev('sources')}
          primary={
            <PrimaryButton onClick={() => next('sources')} disabled={!anyEnabled}>
              {anyEnabled ? 'Next' : 'Enable at least one source'}
            </PrimaryButton>
          }
        />
      }
    >
      <div className="space-y-4">
        {/* LinkedIn */}
        <div className="rounded-md border border-border-subtle bg-surface-raised p-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="font-medium text-ink-primary">LinkedIn</div>
              <div className="text-sm text-ink-secondary">
                Easy Apply jobs run through Vina; external applications go to Ready to Apply.
              </div>
            </div>
            {linkedin?.enabled ? (
              <span className="rounded-pill bg-success-soft px-2 py-0.5 font-mono text-2xs uppercase tracking-wide text-success">
                Connected
              </span>
            ) : (
              <SecondaryButton onClick={() => void onLogin('linkedin')} disabled={login.isPending}>
                Log in
              </SecondaryButton>
            )}
          </div>
        </div>

        {/* Indeed */}
        <div className="rounded-md border border-border-subtle bg-surface-raised p-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="font-medium text-ink-primary">Indeed</div>
              <div className="text-sm text-ink-secondary">
                Quick Apply listings auto-flow; external listings route to Ready to Apply.
              </div>
            </div>
            {indeed?.enabled ? (
              <span className="rounded-pill bg-success-soft px-2 py-0.5 font-mono text-2xs uppercase tracking-wide text-success">
                Connected
              </span>
            ) : (
              <SecondaryButton onClick={() => void onLogin('indeed')} disabled={login.isPending}>
                Log in
              </SecondaryButton>
            )}
          </div>
        </div>

        {/* Google Jobs */}
        <div className="rounded-md border border-border-subtle bg-surface-raised p-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="font-medium text-ink-primary">Google Jobs</div>
              <div className="text-sm text-ink-secondary">
                Discovered via{' '}
                <a
                  href="https://serpapi.com/google-jobs-api"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  SerpAPI
                </a>
                . Always manual-apply (jobs redirect to external ATS).
              </div>
            </div>
            {google?.enabled && settings?.has_serpapi_key && (
              <span className="rounded-pill bg-success-soft px-2 py-0.5 font-mono text-2xs uppercase tracking-wide text-success">
                Connected
              </span>
            )}
          </div>
          {!settings?.has_serpapi_key && (
            <div className="mt-3 flex gap-2">
              <input
                type="password"
                value={serpapiKey}
                onChange={(e) => setSerpapiKey(e.target.value)}
                placeholder="SerpAPI key"
                className="flex-1 rounded-md border border-border-default bg-surface-sunken px-3 py-2 text-sm text-ink-primary outline-none focus:border-accent focus:shadow-accent"
              />
              <SecondaryButton
                onClick={() => void onSaveSerpapi()}
                disabled={serpapiSaving || !serpapiKey.trim()}
              >
                {serpapiSaving ? 'Validating…' : 'Validate & enable'}
              </SecondaryButton>
            </div>
          )}
        </div>
      </div>
    </WizardShell>
  );
}
