import { EventEmitter } from 'node:events';
import type { EventName, EventPayloadFor } from '@vina/shared';

/**
 * Typed, in-process pub/sub. The shared `EVENTS` enum + `EventPayloadFor`
 * mapping mean emitting an unknown event name or wrong-shaped payload is a
 * type error.
 *
 * Subscribers are not async-aware: handlers should never throw — wrap
 * anything fallible in try/catch at the call site.
 */
export interface EventBus {
  emit<T extends EventName>(name: T, payload: EventPayloadFor<T>): void;
  on<T extends EventName>(name: T, handler: (payload: EventPayloadFor<T>) => void): () => void;
}

export function createEventBus(): EventBus {
  const ee = new EventEmitter();
  // Server has the WS gateway, the route handlers (bootstrap), and the
  // worker all subscribing — bump above the default 10 to silence warnings.
  ee.setMaxListeners(50);

  return {
    emit: (name, payload) => {
      ee.emit(name, payload);
    },
    on: (name, handler) => {
      ee.on(name, handler as (payload: unknown) => void);
      return () => {
        ee.off(name, handler as (payload: unknown) => void);
      };
    },
  };
}
