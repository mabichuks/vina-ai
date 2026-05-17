import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  REQUIRED_STEPS,
  STEPS,
  STEP_LABELS,
  useWizardCompletion,
  type StepId,
} from './use-wizard.js';

interface WizardShellProps {
  step: StepId;
  title: string;
  /** Free-form copy beneath the title. */
  subtitle?: string;
  /** Action area at the bottom — typically Back / Skip / Next buttons. */
  footer: ReactNode;
  children: ReactNode;
}

/**
 * Common wizard chrome: progress bar, step title, "Open Dashboard now"
 * escape hatch (PRD-095 / REC 3 — surfaces once all required steps are
 * complete, even if the user is still in an optional step).
 */
export function WizardShell({
  step,
  title,
  subtitle,
  footer,
  children,
}: WizardShellProps): JSX.Element {
  const navigate = useNavigate();
  const { allRequiredDone } = useWizardCompletion();

  const idx = STEPS.indexOf(step);
  const total = STEPS.length;
  const progress = ((idx + 1) / total) * 100;

  return (
    <div className="min-h-screen bg-surface-base text-ink-primary">
      {/* Top progress bar — single accent line, no spinner (theme.md §7). */}
      <div className="fixed inset-x-0 top-0 z-10 h-0.5 bg-surface-sunken">
        <div
          className="h-full bg-accent transition"
          style={{ width: `${progress}%` }}
          aria-hidden
        />
      </div>

      <div className="mx-auto flex min-h-screen max-w-2xl flex-col px-6 py-12">
        <header className="mb-8 flex items-baseline justify-between">
          <p className="font-mono text-2xs uppercase tracking-wide text-ink-muted">
            Step {idx + 1} of {total} · {STEP_LABELS[step]}
          </p>
          {allRequiredDone && step !== 'done' && (
            <button
              type="button"
              className="font-mono text-2xs uppercase tracking-wide text-ink-primary underline hover:no-underline"
              onClick={() => navigate('/onboarding/done')}
            >
              Open dashboard now
            </button>
          )}
        </header>

        <div className="flex-1">
          <h1 className="font-display text-3xl font-headline tracking-tight text-ink-primary">
            {title}
          </h1>
          {subtitle && <p className="mt-2 max-w-prose text-ink-secondary">{subtitle}</p>}

          <div className="mt-8">{children}</div>
        </div>

        <footer className="mt-12 flex items-center justify-between border-t border-border-subtle pt-6">
          {footer}
        </footer>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Standard footer button building blocks                              */
/* ------------------------------------------------------------------ */

interface ButtonProps {
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
  type?: 'button' | 'submit';
  form?: string;
}

export function PrimaryButton({
  onClick,
  disabled,
  children,
  type = 'button',
  form,
}: ButtonProps): JSX.Element {
  return (
    <button
      type={type}
      form={form}
      onClick={onClick}
      disabled={disabled}
      className="rounded-md bg-accent px-5 py-2 text-sm font-medium text-on-accent transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function SecondaryButton({
  onClick,
  disabled,
  children,
  type = 'button',
}: ButtonProps): JSX.Element {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-border-default bg-surface-raised px-5 py-2 text-sm text-ink-primary transition hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function TextButton({ onClick, disabled, children }: ButtonProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-sm text-ink-secondary transition hover:text-ink-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** Standardised footer: Back on the left, optional Skip middle, Next/Primary right. */
export function WizardFooter({
  onBack,
  onSkip,
  primary,
}: {
  onBack?: () => void;
  onSkip?: { label: string; onClick: () => void; disabled?: boolean };
  primary: ReactNode;
}): JSX.Element {
  return (
    <>
      <div>{onBack && <SecondaryButton onClick={onBack}>Back</SecondaryButton>}</div>
      <div className="flex items-center gap-4">
        {onSkip && (
          <TextButton onClick={onSkip.onClick} disabled={onSkip.disabled}>
            {onSkip.label}
          </TextButton>
        )}
        {primary}
      </div>
    </>
  );
}

/** Re-export the gate map so step components can decide skip behaviour. */
export { REQUIRED_STEPS };
