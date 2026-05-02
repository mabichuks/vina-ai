import { useEffect } from 'react';
import { useUiStore, type Toast } from '../store/ui-store.js';

// Toast styling: semantic-soft background + accent-coloured text + neutral
// subtle border. Alpha mixing isn't available because the design system uses
// raw hex values (per docs/theme.md), not RGB triplets.
const TONES: Record<Toast['kind'], string> = {
  info: 'bg-info-soft text-info border-border-subtle',
  success: 'bg-success-soft text-success border-border-subtle',
  warning: 'bg-warning-soft text-warning border-border-subtle',
  error: 'bg-danger-soft text-danger border-border-subtle',
};

const AUTO_DISMISS_MS = 6_000;

function ToastItem({ toast }: { toast: Toast }): JSX.Element {
  const dismiss = useUiStore((s) => s.dismissToast);
  useEffect(() => {
    const t = setTimeout(() => dismiss(toast.id), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [toast.id, dismiss]);

  return (
    <div
      role="status"
      className={`flex items-start gap-3 rounded-md border px-3 py-2 text-sm shadow-xs ${TONES[toast.kind]}`}
    >
      <span className="flex-1">{toast.message}</span>
      <button
        type="button"
        aria-label="Dismiss"
        className="text-current opacity-60 transition hover:opacity-100"
        onClick={() => dismiss(toast.id)}
      >
        ×
      </button>
    </div>
  );
}

export function Toasts(): JSX.Element {
  const toasts = useUiStore((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <ToastItem toast={t} />
        </div>
      ))}
    </div>
  );
}
