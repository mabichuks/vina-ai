import { useState } from 'react';
import type { SkillSummary } from '@vina/shared';
import {
  useCreateSkill,
  useDeleteSkill,
  useSkill,
  useSkills,
  useWriteSkill,
} from '../../api/resources.js';
import { useUiStore } from '../../store/ui-store.js';
import { Button } from '../../components/ui/button.js';

const NEW_SKILL_TEMPLATE = (id: string): string =>
  [
    '---',
    `id: ${id}`,
    `name: ${id}`,
    'description: One sentence describing when this skill applies.',
    'applies_to: [apply]',
    'capabilities: [snapshot, createAlert]',
    'editable_by_user: true',
    'version: 1',
    '---',
    '',
    'How I want Vina to behave when this skill applies.',
    '',
  ].join('\n');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;

/**
 * Settings → Skills. Lists every skill (packaged + user), with an inline
 * editor for editable ones and a "New skill" form for user-authored
 * additions. Packaged safety skills (browser-apply, prompt-editing) show
 * a read-only banner.
 */
export function SkillsTile(): JSX.Element {
  const { data: skills, isLoading } = useSkills();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <section
      id="skills"
      className="rounded-lg border border-border-subtle bg-surface-raised p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-xl font-headline tracking-tight text-ink-primary">
          Skills
        </h2>
        <Button
          variant={creating ? 'ghost' : 'default'}
          size="sm"
          onClick={() => setCreating((v) => !v)}
        >
          {creating ? 'Cancel' : 'New skill'}
        </Button>
      </div>
      <p className="mt-1 text-sm text-ink-secondary">
        Skills are procedures — markdown documents that teach Vina how to use
        its capabilities for a task. Edit a packaged skill to write an
        override, or author a new one for custom behaviour.
      </p>

      {creating ? (
        <NewSkillForm
          onDone={(newId) => {
            setCreating(false);
            if (newId) setSelectedId(newId);
          }}
        />
      ) : null}

      {isLoading ? (
        <p className="mt-4 text-sm text-ink-muted">Loading…</p>
      ) : (
        <ul className="mt-4 divide-y divide-border-subtle">
          {skills.map((s) => (
            <SkillRow
              key={s.id}
              skill={s}
              expanded={selectedId === s.id}
              onToggle={() =>
                setSelectedId((curr) => (curr === s.id ? null : s.id))
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function SkillRow({
  skill,
  expanded,
  onToggle,
}: {
  skill: SkillSummary;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const sourceBadge =
    skill.source === 'override'
      ? { label: 'Overridden', className: 'bg-accent/10 text-accent' }
      : skill.source === 'user'
        ? { label: 'User', className: 'bg-accent/10 text-accent' }
        : null;

  return (
    <li className="py-3">
      <button
        type="button"
        className="flex w-full items-center justify-between text-left"
        onClick={onToggle}
      >
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-ink-primary">{skill.name}</span>
            {sourceBadge ? (
              <span
                className={`rounded px-1.5 py-0.5 text-xs font-medium ${sourceBadge.className}`}
              >
                {sourceBadge.label}
              </span>
            ) : null}
            {!skill.editable_by_user ? (
              <span className="rounded bg-surface-muted px-1.5 py-0.5 text-xs text-ink-muted">
                Read-only
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 text-xs text-ink-muted">
            {skill.id} · v{skill.version}
            {skill.applies_to.length > 0
              ? ` · applies to: ${skill.applies_to.join(', ')}`
              : ''}
          </div>
          <div className="mt-1 text-xs text-ink-secondary">
            {skill.description}
          </div>
        </div>
        <span className="text-ink-muted">{expanded ? '−' : '+'}</span>
      </button>
      {expanded ? <SkillEditor id={skill.id} source={skill.source} /> : null}
    </li>
  );
}

function SkillEditor({
  id,
  source,
}: {
  id: string;
  source: SkillSummary['source'];
}): JSX.Element {
  const { data, isLoading } = useSkill(id);
  const write = useWriteSkill();
  const del = useDeleteSkill();
  const pushToast = useUiStore((s) => s.pushToast);

  const [draft, setDraft] = useState<string>('');
  // Reseed the editable draft when the server sends a new skill object.
  // Render-phase adjustment instead of an effect (matches the previous
  // [data]-keyed behaviour without the cascading-render lint violation).
  const [seededFrom, setSeededFrom] = useState<typeof data>(null);
  if (data && data !== seededFrom) {
    setSeededFrom(data);
    setDraft(data.body);
  }

  if (isLoading || !data) {
    return <p className="mt-2 text-sm text-ink-muted">Loading…</p>;
  }

  const onSave = async (): Promise<void> => {
    try {
      await write.mutate({ id, body: draft });
      pushToast({ kind: 'success', message: 'Skill saved.' });
    } catch (err) {
      pushToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Save failed.',
      });
    }
  };

  const onDelete = async (): Promise<void> => {
    try {
      await del.mutate(id);
      pushToast({
        kind: 'success',
        message:
          source === 'override'
            ? 'Override removed — reverted to default.'
            : 'Skill deleted.',
      });
    } catch (err) {
      pushToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Delete failed.',
      });
    }
  };

  if (!data.editable_by_user) {
    return (
      <div className="mt-3 space-y-2">
        <p className="text-xs text-ink-muted">
          Read-only — this skill governs safety guarantees that user edits
          must not weaken.
        </p>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border-subtle bg-surface-muted p-2 font-mono text-xs text-ink-secondary">
          {data.body}
        </pre>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      <label className="block text-sm text-ink-secondary">Skill body</label>
      <textarea
        className="h-72 w-full rounded border border-border-subtle bg-surface-raised p-2 font-mono text-xs text-ink-primary"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
      />
      <div className="flex gap-2">
        <Button onClick={onSave} disabled={write.isPending}>
          {write.isPending ? 'Saving…' : 'Save'}
        </Button>
        {source !== 'default' ? (
          <Button
            variant="ghost"
            onClick={onDelete}
            disabled={del.isPending}
          >
            {del.isPending
              ? 'Removing…'
              : source === 'override'
                ? 'Revert to default'
                : 'Delete skill'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function NewSkillForm({
  onDone,
}: {
  onDone: (newId: string | null) => void;
}): JSX.Element {
  const create = useCreateSkill();
  const pushToast = useUiStore((s) => s.pushToast);
  const [id, setId] = useState('');
  const [body, setBody] = useState(() => NEW_SKILL_TEMPLATE('my-skill'));
  // Regenerate the template body as the id changes. Render-phase adjustment
  // keyed on the previous id, replacing an [id]-effect.
  const [templatedFor, setTemplatedFor] = useState('');
  if (id !== templatedFor) {
    setTemplatedFor(id);
    setBody(NEW_SKILL_TEMPLATE(id || 'my-skill'));
  }

  const onCreate = async (): Promise<void> => {
    if (!ID_RE.test(id)) {
      pushToast({
        kind: 'error',
        message: 'Id must be lowercase letters, digits, or dashes.',
      });
      return;
    }
    try {
      await create.mutate({ id, body });
      pushToast({ kind: 'success', message: `Skill '${id}' created.` });
      onDone(id);
    } catch (err) {
      pushToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Create failed.',
      });
    }
  };

  return (
    <div className="mt-4 space-y-3 rounded border border-border-subtle bg-surface-muted p-3">
      <div>
        <label className="block text-sm text-ink-secondary">Skill id</label>
        <input
          type="text"
          className="mt-1 w-full rounded border border-border-subtle bg-surface-raised p-2 text-sm text-ink-primary"
          placeholder="e.g. cover-letter-tone"
          value={id}
          onChange={(e) => setId(e.target.value)}
        />
        <p className="mt-1 text-xs text-ink-muted">
          Lowercase letters, digits, and dashes. Must not conflict with a
          packaged safety skill.
        </p>
      </div>
      <div>
        <label className="block text-sm text-ink-secondary">Skill body</label>
        <textarea
          className="mt-1 h-64 w-full rounded border border-border-subtle bg-surface-raised p-2 font-mono text-xs text-ink-primary"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="flex gap-2">
        <Button onClick={onCreate} disabled={create.isPending || !id}>
          {create.isPending ? 'Creating…' : 'Create skill'}
        </Button>
        <Button variant="ghost" onClick={() => onDone(null)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
