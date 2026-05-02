import { describe, expect, it } from 'vitest';
import { createEventBus } from '../../src/events/bus.js';

describe('EventBus', () => {
  it('delivers a typed payload to subscribers and respects unsubscribe', () => {
    const bus = createEventBus();
    const received: Array<{ pending: number; running: number }> = [];
    const off = bus.on('queue:updated', (payload) => received.push(payload));

    bus.emit('queue:updated', { pending: 3, running: 1 });
    bus.emit('queue:updated', { pending: 0, running: 0 });
    expect(received).toEqual([
      { pending: 3, running: 1 },
      { pending: 0, running: 0 },
    ]);

    off();
    bus.emit('queue:updated', { pending: 9, running: 9 });
    expect(received).toHaveLength(2);
  });

  it('supports multiple subscribers per event', () => {
    const bus = createEventBus();
    const a: string[] = [];
    const b: string[] = [];
    bus.on('jobs:updated', (p) => a.push(...p.ids));
    bus.on('jobs:updated', (p) => b.push(...p.ids));

    bus.emit('jobs:updated', { ids: ['j1', 'j2'] });
    expect(a).toEqual(['j1', 'j2']);
    expect(b).toEqual(['j1', 'j2']);
  });
});
