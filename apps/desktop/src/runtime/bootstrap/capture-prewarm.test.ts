import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appConfigDraftMock } from '../../mocks/app-config';
import { installDesktopApi, resetDesktopApiForTests, TauriDesktopApi } from '../desktop-api';
import { captureWarmSignature, scheduleCapturePrewarmAfterStartup } from './capture-prewarm';
import {
  resetNativeWatchDiagnosticGateForTests,
  updateNativeWatchDiagnosticGateFromIpcPing,
} from './watch-mode';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTauri: () => false,
}));

describe('capture pre-warm scheduling', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ data: { ok: true }, warnings: [] });
    resetDesktopApiForTests();
    resetNativeWatchDiagnosticGateForTests();
    installDesktopApi(new TauriDesktopApi());
  });

  afterEach(() => {
    vi.useRealTimers();
    resetDesktopApiForTests();
    resetNativeWatchDiagnosticGateForTests();
  });

  it('fires the warm + preconnect pair immediately for a zero delay', async () => {
    const handle = scheduleCapturePrewarmAfterStartup(structuredClone(appConfigDraftMock), 0);
    await handle.promise;
    // No timer exists on the immediate path; cleanup is a no-op.
    handle.cleanup();

    const actions = invokeMock.mock.calls.map(
      ([, args]) => (args as { command?: { action?: string } } | undefined)?.command?.action,
    );
    expect(actions).toContain('prewarmRoutes');
    expect(actions).toContain('preconnect');
  });

  it('swallows preconnect failures (best-effort warm-up only)', async () => {
    invokeMock.mockImplementation(async (_command: string, args?: { command?: { action?: string } }) => {
      if (args?.command?.action === 'preconnect') throw new Error('no realtime session');
      return { data: { ok: true }, warnings: [] };
    });

    await expect(
      scheduleCapturePrewarmAfterStartup(structuredClone(appConfigDraftMock), 0).promise,
    ).resolves.toBeUndefined();
  });

  it('keeps device prewarm but skips persisted-config websocket preconnect for a native diagnostic', async () => {
    updateNativeWatchDiagnosticGateFromIpcPing(
      'pong storage_status=ready watchDiagnostic=true backendAutostartAuthoritative=true',
    );

    await scheduleCapturePrewarmAfterStartup(structuredClone(appConfigDraftMock), 0).promise;

    const actions = invokeMock.mock.calls.map(
      ([, args]) => (args as { command?: { action?: string } } | undefined)?.command?.action,
    );
    expect(actions).toContain('prewarmRoutes');
    expect(actions).not.toContain('preconnect');
  });

  it('waits for a positive delay and can be cancelled before it fires', () => {
    vi.useFakeTimers();
    const handle = scheduleCapturePrewarmAfterStartup(structuredClone(appConfigDraftMock), 3_000);
    handle.cleanup();
    vi.advanceTimersByTime(3_000);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('derives the warm signature from every device-selection field', () => {
    const config = structuredClone(appConfigDraftMock);
    const baseline = captureWarmSignature(config);
    config.devices.outputDeviceId = 'different-output';
    expect(captureWarmSignature(config)).not.toBe(baseline);
    // Non-device fields do not change the signature.
    const audioOnly = structuredClone(appConfigDraftMock);
    audioOnly.subtitles.overlayFontSize = 99;
    expect(captureWarmSignature(audioOnly)).toBe(baseline);
    // A config without a devices section still yields a stable signature.
    expect(captureWarmSignature({} as never)).toBe(captureWarmSignature({} as never));
  });
});
