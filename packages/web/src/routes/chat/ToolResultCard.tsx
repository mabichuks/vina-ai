import type { ChatMessage } from '@vina/shared';

/**
 * A tool-result card (issue #18). Renders a `tool` chat row: the tool name,
 * its run state, the args it was called with, and its output.
 *
 * `message.metadata` is the JSON string the bridge persists
 * (`{ tool_name, args, state }`); the output is `message.content`.
 */

interface ToolMetadata {
  tool_name?: string | null;
  args?: unknown;
  state?: 'completed' | 'error' | string;
}

function parseMetadata(metadata: string | null): ToolMetadata {
  if (!metadata) return {};
  try {
    return JSON.parse(metadata) as ToolMetadata;
  } catch {
    return {};
  }
}

function summarizeArgs(args: unknown): string {
  if (args == null) return '';
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

export function ToolResultCard({ message }: { message: ChatMessage }): JSX.Element {
  const meta = parseMetadata(message.metadata);
  const label = meta.tool_name ?? 'tool';
  const state = meta.state ?? 'completed';

  return (
    <div className="rounded-md border border-border-subtle bg-surface-sunken px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-ink-secondary">{label}</span>
        <span
          className={`rounded-full px-1.5 py-0.5 text-2xs font-mono ${
            state === 'error' ? 'bg-danger-soft text-danger' : 'bg-info-soft text-info'
          }`}
        >
          {state}
        </span>
      </div>
      {meta.args != null && (
        <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-ink-muted">
          {summarizeArgs(meta.args)}
        </pre>
      )}
      {message.content && (
        <div className="mt-1 whitespace-pre-wrap text-ink-primary">{message.content}</div>
      )}
    </div>
  );
}
