import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installDesktopApi, resetDesktopApiForTests, TauriDesktopApi } from '../desktop-api';
import { PreviewDesktopApi } from '../preview-desktop-api';
import { loggerTestHelpers } from '../logger';
import { scheduleStartupTask } from './schedule';
import {
  enableNativeLogForwarding,
  markStep,
  resetNativeLogForwardingForTests,
} from './steps';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
  isTauri: () => false,
}));

describe('bootstrap step reporting', () => {
  beforeEach(() => {
    loggerTestHelpers.reset();
    resetNativeLogForwardingForTests();
    resetDesktopApiForTests();
  });

  afterEach(() => {
    resetNativeLogForwardingForTests();
    resetDesktopApiForTests();
  });

  it('notifies the listener for every transition and stays silent natively before IPC is proven', () => {
    installDesktopApi(new TauriDesktopApi());
    const seen: Array<[string, string, string | undefined]> = [];
    markStep((stepId, status, detail) => seen.push([stepId, status, detail]), 'detect-runtime', 'active');

    expect(seen).toEqual([['detect-runtime', 'active', undefined]]);
    // Forwarding is disabled until enableNativeLogForwarding(): nothing pending.
    expect(loggerTestHelpers.pendingCount()).toBe(0);
  });

  it('mirrors steps into the logger per level once forwarding is enabled in a native shell', () => {
    installDesktopApi(new TauriDesktopApi());
    enableNativeLogForwarding();

    markStep(undefined, 'check-ipc', 'active', 'starting');
    markStep(undefined, 'init-runtime', 'done', 'ok');
    markStep(undefined, 'load-config', 'error', 'boom');

    expect(loggerTestHelpers.pendingCount()).toBe(3);
    // reset restores the pre-ping silent state.
    resetNativeLogForwardingForTests();
    loggerTestHelpers.reset();
    markStep(undefined, 'init-audio', 'done');
    expect(loggerTestHelpers.pendingCount()).toBe(0);
  });

  it('never forwards steps without a native shell even when enabled', () => {
    installDesktopApi(new PreviewDesktopApi());
    enableNativeLogForwarding();

    markStep(undefined, 'init-runtime', 'done');

    expect(loggerTestHelpers.pendingCount()).toBe(0);
  });
});

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
