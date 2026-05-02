import { useRef, useState } from 'react';
import { useCoverLetters, useUploadCoverLetter } from '../../../api/resources.js';
import { useUiStore } from '../../../store/ui-store.js';
import { PrimaryButton, SecondaryButton, WizardFooter, WizardShell } from '../WizardShell.js';
import { useNextStep, usePrevStep } from '../use-wizard.js';

export function CoverLetter(): JSX.Element {
  const next = useNextStep();
  const prev = usePrevStep();
  const { data: letters } = useCoverLetters();
  const upload = useUploadCoverLetter();
  const pushToast = useUiStore((s) => s.pushToast);
  const fileInput = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [label, setLabel] = useState('');

  const onUpload = async (): Promise<void> => {
    if (!pendingFile) return;
    try {
      await upload.mutate(pendingFile, label || pendingFile.name);
      setPendingFile(null);
      setLabel('');
      if (fileInput.current) fileInput.current.value = '';
    } catch (err) {
      pushToast({ kind: 'error', message: (err as Error).message });
    }
  };

  return (
    <WizardShell
      step="cover-letter"
      title="Cover letter (optional)"
      subtitle="A starting cover letter helps Vina tailor stronger applications. You can skip and add one from Settings later."
      footer={
        <WizardFooter
          onBack={() => prev('cover-letter')}
          onSkip={{ label: 'Skip for now', onClick: () => next('cover-letter') }}
          primary={<PrimaryButton onClick={() => next('cover-letter')}>Next</PrimaryButton>}
        />
      }
    >
      <div className="space-y-6">
        {letters.length > 0 && (
          <ul className="divide-y divide-border-subtle rounded-md border border-border-subtle bg-surface-raised">
            {letters.map((cl) => (
              <li key={cl.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <div className="text-sm text-ink-primary">{cl.label}</div>
                  <div className="font-mono text-2xs text-ink-muted">{cl.original_filename}</div>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="rounded-md border border-dashed border-border-default bg-surface-raised p-6">
          <input
            ref={fileInput}
            type="file"
            accept=".pdf,.docx"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setPendingFile(f);
              if (f && !label) setLabel(f.name.replace(/\.[^.]+$/, ''));
            }}
            className="block w-full text-sm text-ink-secondary file:mr-4 file:rounded-md file:border file:border-border-default file:bg-surface-sunken file:px-3 file:py-1.5 file:text-sm file:text-ink-primary"
          />
          {pendingFile && (
            <div className="mt-4 space-y-3">
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Label"
                className="block w-full rounded-md border border-border-default bg-surface-sunken px-3 py-2 text-sm text-ink-primary outline-none focus:border-accent focus:shadow-accent"
              />
              <SecondaryButton onClick={() => onUpload()} disabled={upload.isPending}>
                {upload.isPending ? 'Uploading…' : 'Upload'}
              </SecondaryButton>
            </div>
          )}
        </div>
      </div>
    </WizardShell>
  );
}
