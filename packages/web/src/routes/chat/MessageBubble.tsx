import type { ChatMessage } from '@vina/shared';
import { ToolResultCard } from './ToolResultCard.js';

/**
 * One chat bubble. User messages are right-aligned on the accent; assistant
 * messages are left-aligned; tool rows render as `ToolResultCard`s. In-flight
 * assistant text (before the finalized `chat:message`) streams via `streaming`.
 */

export function MessageBubble({
  message,
  streaming,
}: {
  message: ChatMessage;
  streaming?: string;
}): JSX.Element {
  if (message.role === 'tool') {
    return <ToolResultCard message={message} />;
  }

  const isUser = message.role === 'user';
  const content = streaming && streaming.length > 0 ? streaming : message.content;

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
          isUser
            ? 'bg-accent text-on-accent'
            : 'bg-surface-raised text-ink-primary border border-border-subtle'
        }`}
      >
        {content}
        {streaming !== undefined && streaming.length > 0 && (
          <span className="inline-block h-4 w-1 animate-pulse bg-current align-middle" />
        )}
      </div>
    </div>
  );
}
