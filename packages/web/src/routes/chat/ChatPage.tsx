import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useChatMessages, useClearChat, useSendChatMessage } from '../../api/resources.js';
import { useChatStore } from '../../store/chat-store.js';
import { Button } from '../../components/ui/button.js';
import { MessageBubble } from './MessageBubble.js';

/**
 * The chat page (issue #18). History hydrates from `/api/chat/messages`; live
 * streaming arrives through the `chat:token`/`chat:message` WebSocket events
 * routed into `chat-store` by `api/ws.ts`.
 */
export default function ChatPage(): JSX.Element {
  const { data: history, isLoading } = useChatMessages();
  const send = useSendChatMessage();
  const clearChat = useClearChat();

  const messages = useChatStore((s) => s.messages);
  const streaming = useChatStore((s) => s.streaming);
  const turnRunning = useChatStore((s) => s.turnRunning);

  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Hydrate the store once history arrives (once only — live updates stream via WS).
  useEffect(() => {
    if (!isLoading && !useChatStore.getState().hydrated) {
      useChatStore.getState().hydrate(history);
    }
  }, [history, isLoading]);

  // Keep the latest message in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  const finalIds = new Set(messages.map((m) => m.id));
  const pendingStreams = Object.entries(streaming).filter(([id]) => !finalIds.has(id));

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const text = draft.trim();
    if (!text || turnRunning) return;
    setDraft('');
    useChatStore.getState().setTurnRunning(true);
    try {
      await send.mutate(text);
    } catch {
      // The server streams a friendly failure message on error; nothing to do here.
    } finally {
      useChatStore.getState().setTurnRunning(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void onSubmit(e as unknown as FormEvent);
    }
  }

  async function onClear(): Promise<void> {
    useChatStore.getState().clear();
    await clearChat.mutate();
  }

  return (
    <section className="flex h-full flex-col">
      <header className="flex items-center justify-between">
        <h1 className="font-display text-3xl font-headline tracking-tight text-ink-primary">
          Chat
        </h1>
        {messages.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => void onClear()}>
            Clear conversation
          </Button>
        )}
      </header>

      <div ref={scrollRef} className="mt-4 flex-1 space-y-3 overflow-y-auto pb-2">
        {messages.length === 0 && pendingStreams.length === 0 && (
          <p className="text-sm text-ink-secondary">
            Ask Vina about your job search — your saved jobs, applications, and next steps.
          </p>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} streaming={streaming[m.id]} />
        ))}
        {pendingStreams.map(([id, text]) => (
          <MessageBubble
            key={id}
            message={{
              id,
              role: 'assistant',
              content: text,
              tool_call_id: null,
              metadata: null,
              created_at: new Date().toISOString(),
            }}
            streaming={text}
          />
        ))}
      </div>

      <form onSubmit={(e) => void onSubmit(e)} className="mt-3 flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder="Ask about your job search…"
          className="min-h-0 flex-1 resize-none rounded-md border border-border bg-surface-raised px-3 py-2 text-sm text-ink-primary placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <Button type="submit" disabled={!draft.trim() || turnRunning}>
          Send
        </Button>
      </form>
    </section>
  );
}
