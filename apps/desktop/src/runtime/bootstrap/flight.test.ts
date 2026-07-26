import { beforeEach, describe, expect, it, vi } from 'vitest';

const startupMock = vi.hoisted(() => ({
  run: vi.fn(),
}));

vi.mock('./startup', () => ({
  runBootstrapDesktopRuntimeBridge: (...args: unknown[]) => startupMock.run(...args),
}));

import { bootstrapDesktopRuntimeBridge } from './flight';
import type { OnBootstrapStep } from './steps';

describe('bootstrap flight dedupe shell', () => {
  beforeEach(() => {
    startupMock.run.mockReset();
  });

  it('shares one in-flight bootstrap, replays steps to late subscribers, and cleans up at zero consumers', async () => {
    const cleanup = vi.fn();
    let broadcast: OnBootstrapStep | undefined;
    let settle: ((cleanup: () => void) => void) | undefined;
    startupMock.run.mockImplementation((onStep: OnBootstrapStep) => {
      broadcast = onStep;
      return new Promise<() => void>((resolve) => {
        settle = resolve;
      });
    });

    const firstSteps: string[] = [];
    const first = bootstrapDesktopRuntimeBridge((stepId, status) => firstSteps.push(`${stepId}:${status}`));
    broadcast?.('detect-runtime', 'active');

    const secondSteps: string[] = [];
    const second = bootstrapDesktopRuntimeBridge((stepId, status) => secondSteps.push(`${stepId}:${status}`));
    // The late subscriber replays the already-emitted snapshot immediately.
    expect(secondSteps).toEqual(['detect-runtime:active']);

    broadcast?.('check-ipc', 'done');
    settle?.(cleanup);
    const [releaseFirst, releaseSecond] = await Promise.all([first, second]);

    expect(startupMock.run).toHaveBeenCalledTimes(1);
    expect(firstSteps).toEqual(['detect-runtime:active', 'check-ipc:done']);
    expect(secondSteps).toEqual(['detect-runtime:active', 'check-ipc:done']);

    releaseFirst();
    expect(cleanup).not.toHaveBeenCalled();
    releaseSecond();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('runs the real cleanup when every consumer released before the bootstrap settled', async () => {
    const cleanup = vi.fn();
    let settle: ((cleanup: () => void) => void) | undefined;
    startupMock.run.mockImplementation(() => new Promise<() => void>((resolve) => {
      settle = resolve;
    }));

    const first = bootstrapDesktopRuntimeBridge();
    const second = bootstrapDesktopRuntimeBridge();
    settle?.(cleanup);
    const [releaseFirst, releaseSecond] = await Promise.all([first, second]);
    releaseSecond();
    releaseFirst();
    expect(cleanup).toHaveBeenCalledTimes(1);

    // A later bootstrap starts a fresh flight.
    startupMock.run.mockResolvedValue(() => {});
    await (await bootstrapDesktopRuntimeBridge())();
    expect(startupMock.run).toHaveBeenCalledTimes(2);
  });

  it('propagates a bootstrap failure to every waiter and clears the flight', async () => {
    startupMock.run.mockRejectedValue(new Error('bootstrap exploded'));

    const first = bootstrapDesktopRuntimeBridge();
    const second = bootstrapDesktopRuntimeBridge();
    await expect(first).rejects.toThrow('bootstrap exploded');
    await expect(second).rejects.toThrow('bootstrap exploded');

    // The failed flight is cleared: the next call starts over (the two
    // waiters above shared a single run).
    startupMock.run.mockResolvedValue(() => {});
    const release = await bootstrapDesktopRuntimeBridge();
    release();
    expect(startupMock.run).toHaveBeenCalledTimes(2);
  });
});
