import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installDesktopApi, resetDesktopApiForTests, TauriDesktopApi } from '../desktop-api';
import { PreviewDesktopApi } from '../preview-desktop-api';
import { loggerTestHelpers } from '../logger';
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
