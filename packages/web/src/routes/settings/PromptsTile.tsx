import { useState } from 'react';
import type { PromptSummary } from '@vina/shared';
import {
  usePrompt,
  usePrompts,
  useRevertPrompt,
  useSavePromptOverride,
} from '../../api/resources.js';
import { useUiStore } from '../../store/ui-store.js';
import { Button } from '../../components/ui/button.js';

/**
 * Settings → Prompts: list every packaged prompt with its current state
 * (default vs override), expand one at a time to view the default body and
 * edit the override. Read-only prompts (`editable_by_user=false`) show their
 * default and hide the editor.
 */
export function PromptsTile(): JSX.Element {
  const { data: prompts, isLoading } = usePrompts();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <section
      id="prompts"
      className="rounded-lg border border-border-subtle bg-surface-raised p-4"
    >
      <h2 className="font-display text-xl font-headline tracking-tight text-ink-primary">
        Prompts
      </h2>
      <p className="mt-1 text-sm text-ink-secondary">
        The natural-language instructions that drive Vina&apos;s graphs. Each prompt
        ships with a default; editing one writes an override that survives
        across restarts. Revert to fall back to the default.
      </p>
      {isLoading ? (
        <p className="mt-4 text-sm text-ink-muted">Loading…</p>
      ) : (
        <ul className="mt-4 divide-y divide-border-subtle">
          {prompts.map((p) => (
            <PromptRow
              key={p.id}
              prompt={p}
              expanded={selectedId === p.id}
              onToggle={() =>
                setSelectedId((curr) => (curr === p.id ? null : p.id))
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function PromptRow({
  prompt,
  expanded,
  onToggle,
}: {
  prompt: PromptSummary;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <li className="py-3">
      <button
        type="button"
        className="flex w-full items-center justify-between text-left"
        onClick={onToggle}
      >
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-ink-primary">{prompt.title}</span>
            {prompt.is_overridden ? (
              <span className="rounded bg-accent/10 px-1.5 py-0.5 text-xs font-medium text-accent">
                Overridden
              </span>
            ) : null}
            {!prompt.editable_by_user ? (
              <span className="rounded bg-surface-muted px-1.5 py-0.5 text-xs text-ink-muted">
                Read-only
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 text-xs text-ink-muted">
            {prompt.id} · v{prompt.version} · graph: {prompt.graph}
          </div>
        </div>
        <span className="text-ink-muted">{expanded ? '−' : '+'}</span>
      </button>
      {expanded ? <PromptEditor id={prompt.id} /> : null}
    </li>
  );
}

function PromptEditor({ id }: { id: string }): JSX.Element {
  const { data, isLoading } = usePrompt(id);
  const save = useSavePromptOverride();
  const revert = useRevertPrompt();
  const pushToast = useUiStore((s) => s.pushToast);

  const [draft, setDraft] = useState<string>('');
  // Reseed the editable draft whenever the server sends a new prompt object
  // (initial load, save, revert). Render-phase adjustment instead of an
  // effect — matches the previous [data]-keyed behaviour without the
  // cascading-render lint violation.
  const [seededFrom, setSeededFrom] = useState<typeof data>(undefined);
  if (data && data !== seededFrom) {
    setSeededFrom(data);
    // Prefer the current override body; if none, seed from the default so the
    // user can edit a copy rather than starting blank.
    setDraft(data.override_body ?? data.default_body);
  }

  if (isLoading || !data) {
    return <p className="mt-2 text-sm text-ink-muted">Loading…</p>;
  }

  const onSave = async (): Promise<void> => {
    try {
      await save.mutate({ id, body: draft });
      pushToast({ kind: 'success', message: 'Prompt override saved.' });
    } catch (err) {
      pushToast({
        kind: 'error',
        message:
          err instanceof Error ? err.message : 'Save failed — see server logs.',
      });
    }
  };

  const onRevert = async (): Promise<void> => {
    try {
      await revert.mutate(id);
      pushToast({ kind: 'success', message: 'Reverted to default.' });
    } catch (err) {
      pushToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Revert failed.',
      });
    }
  };

  return (
    <div className="mt-3 space-y-3">
      <details className="rounded border border-border-subtle bg-surface-muted px-3 py-2">
        <summary className="cursor-pointer text-sm text-ink-secondary">
          Default body (read-only)
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-ink-secondary">
          {data.default_body}
        </pre>
      </details>

      {data.editable_by_user ? (
        <div>
          <label className="block text-sm text-ink-secondary">
            Override body
          </label>
          <textarea
            className="mt-1 h-72 w-full rounded border border-border-subtle bg-surface-raised p-2 font-mono text-xs text-ink-primary"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
          />
          <div className="mt-2 flex gap-2">
            <Button onClick={onSave} disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save override'}
            </Button>
            {data.is_overridden ? (
              <Button
                variant="ghost"
                onClick={onRevert}
                disabled={revert.isPending}
              >
                {revert.isPending ? 'Reverting…' : 'Revert to default'}
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="text-xs text-ink-muted">
          This prompt is read-only — it governs safety guarantees that user
          edits must not weaken.
        </p>
      )}
    </div>
  );
}
