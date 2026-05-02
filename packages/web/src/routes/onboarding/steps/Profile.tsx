import { useState } from 'react';
import type { Profile as ProfileRow } from '@vina/shared';
import { useUiStore } from '../../../store/ui-store.js';
import { useProfile, useSaveProfile } from '../../../api/resources.js';
import { PrimaryButton, WizardFooter, WizardShell } from '../WizardShell.js';
import { useNextStep, usePrevStep } from '../use-wizard.js';

interface FormState {
  full_name: string;
  email: string;
  phone: string;
  location: string;
  linkedin_url: string;
  website_url: string;
}

const EMPTY: FormState = {
  full_name: '',
  email: '',
  phone: '',
  location: '',
  linkedin_url: '',
  website_url: '',
};

/**
 * Auto-prepend `https://` if the user typed a URL without a scheme. zod's
 * `z.url()` is strict — `linkedin.com/in/me` fails. This is the polite UX:
 * accept what people naturally type.
 */
function ensureScheme(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  return `https://${url}`;
}

function rowToForm(row: ProfileRow): FormState {
  return {
    full_name: row.full_name,
    email: row.email,
    phone: row.phone ?? '',
    location: row.location ?? '',
    linkedin_url: row.linkedin_url ?? '',
    website_url: row.website_url ?? '',
  };
}

/**
 * Loader: waits for the server fetch, then mounts the form with a stable key
 * so the inner component's useState lazy initializer runs once with the
 * resolved data. Avoids the "sync via useEffect" anti-pattern.
 */
export function Profile(): JSX.Element {
  const { data: existing, isLoading } = useProfile();
  if (isLoading) return <ProfileForm key="loading" initial={null} disabled />;
  return <ProfileForm key={existing ? 'edit' : 'new'} initial={existing} />;
}

function ProfileForm({
  initial,
  disabled,
}: {
  initial: ProfileRow | null;
  disabled?: boolean;
}): JSX.Element {
  const next = useNextStep();
  const prev = usePrevStep();
  const save = useSaveProfile();
  const pushToast = useUiStore((s) => s.pushToast);
  const [form, setForm] = useState<FormState>(() => (initial ? rowToForm(initial) : EMPTY));
  const [submitted, setSubmitted] = useState(false);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSubmitted(true);
    if (!form.full_name.trim() || !form.email.trim()) return;

    const payload = {
      full_name: form.full_name.trim(),
      email: form.email.trim(),
      ...(form.phone.trim() && { phone: form.phone.trim() }),
      ...(form.location.trim() && { location: form.location.trim() }),
      ...(form.linkedin_url.trim() && { linkedin_url: ensureScheme(form.linkedin_url.trim()) }),
      ...(form.website_url.trim() && { website_url: ensureScheme(form.website_url.trim()) }),
    };

    try {
      // Idempotent: PATCH if profile already exists, POST if it doesn't (REC 2).
      await save.mutate(payload, initial !== null);
      next('profile');
    } catch (err) {
      pushToast({ kind: 'error', message: (err as Error).message });
    }
  };

  return (
    <WizardShell
      step="profile"
      title="Tell us who you are"
      subtitle="The basics for tailored cover letters and applications."
      footer={
        <WizardFooter
          onBack={() => prev('profile')}
          primary={
            <PrimaryButton type="submit" form="profile-form" disabled={save.isPending || disabled}>
              {save.isPending ? 'Saving…' : 'Next'}
            </PrimaryButton>
          }
        />
      }
    >
      <form id="profile-form" onSubmit={(e) => void onSubmit(e)} className="space-y-4">
        <Field
          label="Full name"
          required
          value={form.full_name}
          onChange={(v) => setForm({ ...form, full_name: v })}
          error={submitted && !form.full_name.trim() ? 'Required' : undefined}
        />
        <Field
          label="Email"
          required
          type="email"
          value={form.email}
          onChange={(v) => setForm({ ...form, email: v })}
          error={submitted && !form.email.trim() ? 'Required' : undefined}
        />
        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Phone"
            value={form.phone}
            onChange={(v) => setForm({ ...form, phone: v })}
          />
          <Field
            label="Location"
            placeholder="e.g. London, UK"
            value={form.location}
            onChange={(v) => setForm({ ...form, location: v })}
          />
        </div>
        <Field
          label="LinkedIn URL"
          value={form.linkedin_url}
          onChange={(v) => setForm({ ...form, linkedin_url: v })}
        />
        <Field
          label="Website"
          value={form.website_url}
          onChange={(v) => setForm({ ...form, website_url: v })}
        />
      </form>
    </WizardShell>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  type?: string;
  placeholder?: string;
  error?: string;
}

export function Field({
  label,
  value,
  onChange,
  required,
  type = 'text',
  placeholder,
  error,
}: FieldProps): JSX.Element {
  return (
    <label className="block">
      <span className="font-mono text-2xs uppercase tracking-wide text-ink-secondary">
        {label}
        {required && <span aria-hidden> *</span>}
      </span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block w-full rounded-md border border-border-default bg-surface-sunken px-3 py-2 text-base text-ink-primary outline-none transition focus:border-accent focus:shadow-accent"
      />
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </label>
  );
}
