import { createLogger } from '@vina/shared';
import type { OpenCodeHost } from './host.js';

/**
 * Session driver for the task-session handlers (prepare_manual_apply, review).
 * Extracted from the chat bridge (#18): creates a session against one agent,
 * prompts it, and waits for idle / failure / a tool-round cap. The handlers
 * then verify the DB reached the expected terminal state — the session is
 * never the source of truth (docs/opencode-orchestration.md §6).
 *
 * The interface is deliberately narrow so handler tests inject a fake that
 * records the agent + prompt and simulates the terminal state without booting
 * an embedded OpenCode host.
 */

const log = createLogger('opencode-session-driver');

export type SessionRunOutcome =
  | { reason: 'idle' }
  | { reason: 'failed'; error: string }
  | { reason: 'cap_exceeded'; toolRounds: number };

export interface SessionRunInput {
  /** Agent id, e.g. `vina-materials` or `vina-review`. */
  agent: string;
  /** The prompt the session starts with (skill name + task facts). */
  prompt: string;
  /** Bound on tool rounds before the run is cut short. Default 8. */
  maxToolRounds?: number;
  /** When true, record the tool calls (name + input) in `SessionRunResult.toolEvents`. */
  collectToolEvents?: boolean;
}

/** One tool call observed during a run, for the external event bridge (#21). */
export interface SessionToolEvent {
  /** Effective tool name (e.g. `playwright_type`, `vina_external_submit`). */
  tool: string;
  /** Raw tool input, if the event carries it. */
  input?: unknown;
}

export interface SessionRunResult {
  sessionId: string;
  outcome: SessionRunOutcome;
  /** Tool calls observed during the run, in order. Empty unless the caller opts in. */
  toolEvents?: SessionToolEvent[];
}

export interface SessionDriver {
  run(input: SessionRunInput): Promise<SessionRunResult>;
}

const DEFAULT_MAX_TOOL_ROUNDS = 8;

/**
 * Consume the event stream for one session until it idles, fails, or exceeds
 * the tool-round cap. Started *before* `session.prompt` (as the chat bridge
 * does) so no early event is missed.
 */
async function collectOutcome(
  host: OpenCodeHost,
  sessionId: string,
  maxToolRounds: number,
  collectToolEvents: boolean,
): Promise<{ outcome: SessionRunOutcome; toolEvents: SessionToolEvent[] }> {
  let toolRounds = 0;
  const toolEvents: SessionToolEvent[] = [];
  for await (const event of host.client.event.subscribe()) {
    const data = (event as { data?: { sessionID?: string } }).data;
    if (!data || data.sessionID !== sessionId) continue;

    switch (event.type) {
      case 'session.tool.success':
      case 'session.tool.failed': {
        toolRounds += 1;
        if (collectToolEvents) {
          const tool = (event as unknown as { data: { tool?: string; input?: unknown } }).data;
          toolEvents.push({ tool: tool.tool ?? 'unknown', input: tool.input });
        }
        if (toolRounds >= maxToolRounds)
          return { outcome: { reason: 'cap_exceeded', toolRounds }, toolEvents };
        break;
      }

      case 'session.execution.failed': {
        const d = (event as unknown as { data: { error: { message: string } } }).data;
        return { outcome: { reason: 'failed', error: d.error.message }, toolEvents };
      }

      case 'session.idle':
        return { outcome: { reason: 'idle' }, toolEvents };
    }
  }

  return { outcome: { reason: 'idle' }, toolEvents };
}

export function createSessionDriver(host: OpenCodeHost): SessionDriver {
  return {
    async run(input: SessionRunInput): Promise<SessionRunResult> {
      const session = await host.client.session.create({ agent: input.agent });
      const sessionId = session.id;
      const done = collectOutcome(
        host,
        sessionId,
        input.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS,
        input.collectToolEvents ?? false,
      );
      await host.client.session.prompt({ sessionID: sessionId, text: input.prompt });
      const { outcome, toolEvents } = await done;

      if (outcome.reason === 'failed') {
        log.warn({ agent: input.agent, sessionId, error: outcome.error }, 'agent session failed');
      }

      return { sessionId, outcome, ...(input.collectToolEvents ? { toolEvents } : {}) };
    },
  };
}
