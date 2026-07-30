import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleStartupTask } from './schedule';

describe('scheduleStartupTask', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ['synchronous throw', () => { throw new Error('sync'); }],
    ['asynchronous rejection', () => Promise.reject(new Error('async'))],
  ])('settles without leaking a rejection for %s', async (_name, task) => {
    await expect(scheduleStartupTask(task, 0).promise).resolves.toBeUndefined();
  });

  it('settles the completion promise when a delayed task is cancelled', async () => {
    vi.useFakeTimers();
    const task = vi.fn();
    const handle = scheduleStartupTask(task, 100);
    handle.cleanup();
    await expect(handle.promise).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    expect(task).not.toHaveBeenCalled();
  });
});
