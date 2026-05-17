import { useRef, useState } from 'react';
import { useCvs, useUploadCv } from '../../../api/resources.js';
import { useUiStore } from '../../../store/ui-store.js';
import { PrimaryButton, SecondaryButton, WizardFooter, WizardShell } from '../WizardShell.js';
import { useNextStep, usePrevStep } from '../use-wizard.js';

export function Cv(): JSX.Element {
  const next = useNextStep();
  const prev = usePrevStep();
  const { data: cvs } = useCvs();
  const upload = useUploadCv();
  const pushToast = useUiStore((s) => s.pushToast);
  const fileInput = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [label, setLabel] = useState('');

  const onChooseFile = (file: File | null): void => {
    setPendingFile(file);
    if (file && !label) setLabel(file.name.replace(/\.[^.]+$/, ''));
  };

  const onUpload = async (): Promise<void> => {
    if (!pendingFile) return;
    try {
      await upload.mutate(pendingFile, label || pendingFile.name, cvs.length === 0);
      setPendingFile(null);
      setLabel('');
      if (fileInput.current) fileInput.current.value = '';
    } catch (err) {
      pushToast({ kind: 'error', message: (err as Error).message });
    }
  };

  return (
    <WizardShell
      step="cv"
      title="Upload your CV"
      subtitle="PDF or DOCX, up to 10MB. Vina extracts the text to use as a starting point for tailoring — your file stays on disk untouched."
      footer={
        <WizardFooter
          onBack={() => prev('cv')}
          primary={
            <PrimaryButton onClick={() => next('cv')} disabled={cvs.length === 0}>
              {cvs.length === 0 ? 'Upload at least one to continue' : 'Next'}
            </PrimaryButton>
          }
        />
      }
    >
      <div className="space-y-6">
        {cvs.length > 0 && (
          <div>
            <h2 className="font-mono text-2xs uppercase tracking-wide text-ink-secondary">
              On file
            </h2>
            <ul className="mt-2 divide-y divide-border-subtle rounded-md border border-border-subtle bg-surface-raised">
              {cvs.map((cv) => (
                <li key={cv.id} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <div className="text-sm text-ink-primary">{cv.label}</div>
                    <div className="font-mono text-2xs text-ink-muted">{cv.original_filename}</div>
                  </div>
                  {cv.is_default && (
                    <span className="rounded-pill bg-accent-soft px-2 py-0.5 font-mono text-2xs uppercase tracking-wide text-ink-primary">
                      Default
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="rounded-md border border-dashed border-border-default bg-surface-raised p-6">
          <input
            ref={fileInput}
            type="file"
            accept=".pdf,.docx"
            onChange={(e) => onChooseFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-ink-secondary file:mr-4 file:rounded-md file:border file:border-border-default file:bg-surface-sunken file:px-3 file:py-1.5 file:text-sm file:text-ink-primary"
          />
          {pendingFile && (
            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="font-mono text-2xs uppercase tracking-wide text-ink-secondary">
                  Label
                </span>
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-border-default bg-surface-sunken px-3 py-2 text-sm text-ink-primary outline-none focus:border-accent focus:shadow-accent"
                />
              </label>
              <div className="flex gap-3">
                <SecondaryButton onClick={() => onUpload()} disabled={upload.isPending}>
                  {upload.isPending ? 'Uploading…' : 'Upload'}
                </SecondaryButton>
                <button
                  type="button"
                  className="text-sm text-ink-secondary hover:text-ink-primary hover:underline"
                  onClick={() => {
                    setPendingFile(null);
                    setLabel('');
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </WizardShell>
  );
}
