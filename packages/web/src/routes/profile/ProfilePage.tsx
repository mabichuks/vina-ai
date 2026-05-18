import { useRef, useState } from 'react';
import type { Cv, Profile as ProfileRow } from '@vina/shared';
import {
  useCvs,
  useDeleteCv,
  useProfile,
  useSaveProfile,
  useSetDefaultCv,
  useUploadCv,
} from '../../api/resources.js';
import { downloadAuthed } from '../../api/client.js';
import { useUiStore } from '../../store/ui-store.js';
import { Button } from '../../components/ui/button.js';

export function ProfilePage(): JSX.Element {
  const profile = useProfile();
  const cvs = useCvs();

  if (profile.isLoading || cvs.isLoading) {
    return <p className="p-6 text-sm text-ink-secondary">Loading…</p>;
  }

  return (
    <section className="space-y-6">
      <h1 className="font-display text-3xl font-headline tracking-tight text-ink-primary">
        Profile
      </h1>
      <ProfileTile initial={profile.data} />
      <CvTile cvs={cvs.data} />
    </section>
  );
}

function ProfileTile({ initial }: { initial: ProfileRow | null }): JSX.Element {
  const save = useSaveProfile();
  const pushToast = useUiStore((s) => s.pushToast);
  const exists = initial !== null;
  const [fullName, setFullName] = useState(initial?.full_name ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [bio, setBio] = useState(initial?.bio ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [location, setLocation] = useState(initial?.location ?? '');

  const submit = async (): Promise<void> => {
    try {
      await save.mutate(
        {
          full_name: fullName.trim(),
          email: email.trim(),
          ...(bio.trim() && { bio: bio.trim() }),
          ...(phone.trim() && { phone: phone.trim() }),
          ...(location.trim() && { location: location.trim() }),
        },
        exists,
      );
      pushToast({ kind: 'info', message: 'Profile saved.' });
    } catch (err) {
      pushToast({ kind: 'error', message: (err as Error).message });
    }
  };

  return (
    <section className="rounded-lg border border-border-subtle bg-surface-raised p-4">
      <h2 className="font-display text-xl font-headline tracking-tight text-ink-primary">
        Identity
      </h2>
      <p className="mt-1 text-sm text-ink-secondary">
        Goes into the tailoring header and the scoring rubric. Bio is the
        free-text &ldquo;who am I&rdquo; line the LLM sees.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="font-mono text-2xs uppercase tracking-wide text-ink-secondary">
            Full name
          </span>
          <input
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="mt-1 block w-full rounded-md border border-border-default bg-surface-sunken px-3 py-2 text-base text-ink-primary outline-none focus:border-accent focus:shadow-accent"
          />
        </label>
        <label className="block">
          <span className="font-mono text-2xs uppercase tracking-wide text-ink-secondary">
            Email
          </span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 block w-full rounded-md border border-border-default bg-surface-sunken px-3 py-2 text-base text-ink-primary outline-none focus:border-accent focus:shadow-accent"
          />
        </label>
        <label className="block">
          <span className="font-mono text-2xs uppercase tracking-wide text-ink-secondary">
            Phone (optional)
          </span>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="mt-1 block w-full rounded-md border border-border-default bg-surface-sunken px-3 py-2 text-base text-ink-primary outline-none focus:border-accent focus:shadow-accent"
          />
        </label>
        <label className="block">
          <span className="font-mono text-2xs uppercase tracking-wide text-ink-secondary">
            Location (optional)
          </span>
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="e.g. Liverpool, UK"
            className="mt-1 block w-full rounded-md border border-border-default bg-surface-sunken px-3 py-2 text-base text-ink-primary outline-none focus:border-accent focus:shadow-accent"
          />
        </label>
        <label className="block sm:col-span-2">
          <span className="font-mono text-2xs uppercase tracking-wide text-ink-secondary">
            Bio (optional)
          </span>
          <textarea
            rows={3}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="e.g. Backend engineer focused on Postgres-heavy systems."
            className="mt-1 block w-full rounded-md border border-border-default bg-surface-sunken px-3 py-2 text-base text-ink-primary outline-none focus:border-accent focus:shadow-accent"
          />
        </label>
      </div>
      <div className="mt-4">
        <Button onClick={() => void submit()} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save profile'}
        </Button>
      </div>
    </section>
  );
}

function CvTile({ cvs }: { cvs: Cv[] }): JSX.Element {
  const upload = useUploadCv();
  const setDefault = useSetDefaultCv();
  const remove = useDeleteCv();
  const pushToast = useUiStore((s) => s.pushToast);
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<File | null>(null);
  const [label, setLabel] = useState('');

  const onChooseFile = (file: File | null): void => {
    setPending(file);
    if (file && !label) setLabel(file.name.replace(/\.[^.]+$/, ''));
  };

  const onUpload = async (): Promise<void> => {
    if (!pending) return;
    try {
      await upload.mutate(pending, label || pending.name, cvs.length === 0);
      pushToast({ kind: 'info', message: 'CV uploaded.' });
      setPending(null);
      setLabel('');
      if (fileInput.current) fileInput.current.value = '';
    } catch (err) {
      pushToast({ kind: 'error', message: (err as Error).message });
    }
  };

  return (
    <section className="rounded-lg border border-border-subtle bg-surface-raised p-4">
      <h2 className="font-display text-xl font-headline tracking-tight text-ink-primary">
        CVs
      </h2>
      <p className="mt-1 text-sm text-ink-secondary">
        The default CV is the source Vina rewrites when tailoring a manual-apply
        job. Upload more to switch between templates.
      </p>

      {cvs.length > 0 && (
        <ul className="mt-4 divide-y divide-border-subtle rounded-md border border-border-subtle bg-surface-sunken">
          {cvs.map((cv) => (
            <li key={cv.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm text-ink-primary">{cv.label}</span>
                  {cv.is_default && (
                    <span className="rounded-pill bg-accent-soft px-2 py-0.5 font-mono text-2xs uppercase tracking-wide text-ink-primary">
                      Default
                    </span>
                  )}
                </div>
                <div className="font-mono text-2xs text-ink-muted">{cv.original_filename}</div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await downloadAuthed(`/api/cvs/${cv.id}/download`, cv.original_filename);
                    } catch (err) {
                      pushToast({
                        kind: 'error',
                        message: err instanceof Error ? err.message : String(err),
                      });
                    }
                  }}
                  className="rounded-md border border-border-subtle bg-surface-raised px-3 py-1 text-xs text-ink-primary hover:bg-surface-base"
                >
                  Download
                </button>
                {!cv.is_default && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={setDefault.isPending}
                    onClick={async () => {
                      try {
                        await setDefault.mutate(cv.id);
                        pushToast({ kind: 'info', message: 'Default CV updated.' });
                      } catch (err) {
                        pushToast({ kind: 'error', message: (err as Error).message });
                      }
                    }}
                  >
                    Make default
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={async () => {
                    if (
                      !confirm(
                        cv.is_default
                          ? 'Delete the default CV? Another CV will be auto-promoted.'
                          : `Delete '${cv.label}'?`,
                      )
                    )
                      return;
                    try {
                      await remove.mutate(cv.id);
                      pushToast({ kind: 'info', message: 'CV deleted.' });
                    } catch (err) {
                      pushToast({ kind: 'error', message: (err as Error).message });
                    }
                  }}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 rounded-md border border-dashed border-border-default bg-surface-sunken p-4">
        <span className="font-mono text-2xs uppercase tracking-wide text-ink-secondary">
          {cvs.length === 0 ? 'Upload your CV' : 'Upload another'}
        </span>
        <input
          ref={fileInput}
          type="file"
          accept=".pdf,.docx"
          onChange={(e) => onChooseFile(e.target.files?.[0] ?? null)}
          className="mt-2 block w-full text-sm text-ink-secondary file:mr-4 file:rounded-md file:border file:border-border-default file:bg-surface-raised file:px-3 file:py-1.5 file:text-sm file:text-ink-primary"
        />
        {pending && (
          <div className="mt-3 space-y-3">
            <label className="block">
              <span className="font-mono text-2xs uppercase tracking-wide text-ink-secondary">
                Label
              </span>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="mt-1 block w-full rounded-md border border-border-default bg-surface-raised px-3 py-2 text-sm text-ink-primary outline-none focus:border-accent focus:shadow-accent"
              />
            </label>
            <div className="flex gap-3">
              <Button onClick={() => void onUpload()} disabled={upload.isPending}>
                {upload.isPending ? 'Uploading…' : 'Upload'}
              </Button>
              <button
                type="button"
                className="text-sm text-ink-secondary hover:text-ink-primary hover:underline"
                onClick={() => {
                  setPending(null);
                  setLabel('');
                  if (fileInput.current) fileInput.current.value = '';
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
