import { afterEach, describe, expect, it } from 'vitest';
import {
  cancelActiveTask,
  cancelTasksForSite,
  registerActiveTask,
  unregisterActiveTask,
  _resetActiveTasksForTests,
} from '../../src/queue/active-tasks.js';

afterEach(() => _resetActiveTasksForTests());

describe('active-tasks registry', () => {
  it('register returns a fresh signal, abort flips signal.aborted', () => {
    const signal = registerActiveTask('t1', 'google');
    expect(signal.aborted).toBe(false);
    expect(cancelActiveTask('t1')).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  it('cancelActiveTask returns false when the task is unknown', () => {
    expect(cancelActiveTask('nonexistent')).toBe(false);
  });

  it('unregisterActiveTask removes the task without aborting', () => {
    const signal = registerActiveTask('t2', 'google');
    unregisterActiveTask('t2');
    expect(cancelActiveTask('t2')).toBe(false);
    expect(signal.aborted).toBe(false);
  });

  it('cancelTasksForSite aborts every task on that site and returns the aborted ids', () => {
    const s1 = registerActiveTask('a', 'google');
    const s2 = registerActiveTask('b', 'google');
    const s3 = registerActiveTask('c', 'linkedin');
    expect(cancelTasksForSite('google')).toEqual(['a', 'b']);
    expect(s1.aborted).toBe(true);
    expect(s2.aborted).toBe(true);
    expect(s3.aborted).toBe(false);
  });

  it('registering the same taskId twice replaces the prior entry without leaking', () => {
    const s1 = registerActiveTask('dupe', 'google');
    const s2 = registerActiveTask('dupe', 'google');
    expect(s1).not.toBe(s2);
    expect(cancelActiveTask('dupe')).toBe(true);
    expect(s2.aborted).toBe(true);
    expect(cancelActiveTask('dupe')).toBe(false);
  });
});
