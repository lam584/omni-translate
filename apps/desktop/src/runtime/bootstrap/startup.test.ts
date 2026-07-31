import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  waitForTauri: vi.fn(),
  connect: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', async () => (await import('../../test-utils/tauri-invoke-mock')).tauriCoreMockModule());

// This suite tests the composition root's own detection/recovery machine, so
// simulating the environment module is the sanctioned mechanism here.
vi.mock('../tauri-runtime', () => ({
  isTauriRuntime: () => mocks.isTauri(),
  waitForTauriRuntime: (...args: unknown[]) => mocks.waitForTauri(...args),
}));

vi.mock('./connect', () => ({
  CONFIG_DRAFT_SYNC_EVENT: 'config://draft-updated',
  connectDesktopRuntimeBridge: (...args: unknown[]) => mocks.connect(...args),
}));

import { appConfigDraftMock } from '../../mocks/app-config';
import { useAppStore } from '../../stores/app-store';
import { resetDesktopApiForTests } from '../desktop-api';
import { getRecentFrontendLogEntries, loggerTestHelpers } from '../logger';
import { CONFIG_DRAFT_FALLBACK_STORAGE_KEY } from './config-fallback';
import { runBootstrapDesktopRuntimeBridge } from './startup';
import { resetNativeLogForwardingForTests } from './steps';
import { invokeMock } from '../../test-utils/tauri-invoke-mock';
import {
  isNativeWatchDiagnosticAutostartAuthoritative,
  resetNativeWatchDiagnosticGateForTests,
} from './watch-mode';

/** Resets timers, IPC/runtime mocks and bootstrap singletons for one describe run. */
function resetStartupHarness({ isTauri = false } = {}) {
  vi.useFakeTimers();
  invokeMock.mockReset();
  mocks.isTauri.mockReset().mockReturnValue(isTauri);
  mocks.waitForTauri.mockReset().mockResolvedValue(false);
  mocks.connect.mockReset().mockResolvedValue(() => {});
  window.localStorage.clear();
  loggerTestHelpers.reset();
  resetNativeLogForwardingForTests();
  resetNativeWatchDiagnosticGateForTests();
  resetDesktopApiForTests();
}

/** Registers the shared beforeEach/afterEach pair for a bootstrap describe. */
function registerStartupHooks(options: { isTauri?: boolean } = {}) {
  beforeEach(() => {
    resetStartupHarness(options);
  });
  afterEach(() => {
    vi.useRealTimers();
    resetNativeLogForwardingForTests();
    resetNativeWatchDiagnosticGateForTests();
    resetDesktopApiForTests();
  });
}

describe('runBootstrapDesktopRuntimeBridge state machine', () => {
  registerStartupHooks();

  beforeEach(() => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: structuredClone(appConfigDraftMock),
      runtimeNotifications: [],
    }));
  });

  it('logs a late-heal connect failure without crashing the preview session', async () => {
    // Initial wait fails -> preview; the heal wait succeeds later, but the
    // reconnect throws.
    mocks.waitForTauri
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mocks.connect.mockRejectedValue(new Error('heal connect failed'));

    const cleanup = await runBootstrapDesktopRuntimeBridge();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    // The flush may already have run in preview mode; the bounded ring keeps
    // the record either way.
    const ring = getRecentFrontendLogEntries().map((entry) => entry.summary);
    expect(ring.some((summary) => summary.includes('desktop runtime late heal failed'))).toBe(true);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('skips the healed reconnect entirely once the session was cleaned up', async () => {
    let resolveHeal: ((available: boolean) => void) | undefined;
    mocks.waitForTauri
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveHeal = resolve; }));

    const cleanup = await runBootstrapDesktopRuntimeBridge();
    cleanup();
    resolveHeal?.(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('reports connect failures after a successful ping as step errors and a warning', async () => {
    mocks.isTauri.mockReturnValue(true);
    invokeMock.mockResolvedValue('pong');
    mocks.connect.mockRejectedValue(new Error('connect blew up'));

    const steps: string[] = [];
    const cleanup = await runBootstrapDesktopRuntimeBridge((stepId, status) => steps.push(`${stepId}:${status}`));

    expect(steps).toContain('init-runtime:error');
    expect(steps).toContain('load-config:error');
    const messages = useAppStore.getState().runtimeNotifications.map((item) => item.message);
    expect(messages.some((message) => message.includes('Desktop runtime connect failed after IPC ping'))).toBe(true);
    cleanup();
  });

  it('leaves an equal local fallback in place without rewriting the store draft', async () => {
    mocks.isTauri.mockReturnValue(true);
    invokeMock.mockResolvedValue('pong');
    const current = useAppStore.getState().configDraft;
    window.localStorage.setItem(CONFIG_DRAFT_FALLBACK_STORAGE_KEY, JSON.stringify(current));
    const setConfigDraftSpy = vi.spyOn(useAppStore.getState(), 'setConfigDraft');

    const cleanup = await runBootstrapDesktopRuntimeBridge();

    expect(setConfigDraftSpy).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(CONFIG_DRAFT_FALLBACK_STORAGE_KEY)).toBeNull();
    cleanup();
    setConfigDraftSpy.mockRestore();
  });

  it('recovers over the background IPC probe after the startup ping window fails', async () => {
    mocks.isTauri.mockReturnValue(true);
    let pings = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command !== 'debug_ipc_ping') throw new Error(`unexpected ${command}`);
      pings += 1;
      // The startup window burns 11 attempts; the first background probe
      // fails once more, the second succeeds.
      if (pings <= 12) throw new Error('ipc still down');
      return 'pong';
    });

    const cleanupPromise = runBootstrapDesktopRuntimeBridge();
    await vi.advanceTimersByTimeAsync(30_000);
    const cleanup = await cleanupPromise;
    await vi.advanceTimersByTimeAsync(6_000);

    expect(mocks.connect).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('stops probing once the recovery window has fully elapsed', async () => {
    mocks.isTauri.mockReturnValue(true);
    invokeMock.mockRejectedValue(new Error('ipc permanently down'));

    const cleanupPromise = runBootstrapDesktopRuntimeBridge();
    await vi.advanceTimersByTimeAsync(30_000);
    const cleanup = await cleanupPromise;
    // Exhaust the 60s recovery budget; afterwards no further probes fire.
    await vi.advanceTimersByTimeAsync(70_000);
    const pingsAtDeadline = invokeMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(invokeMock.mock.calls.length).toBe(pingsAtDeadline);
    expect(mocks.connect).not.toHaveBeenCalled();
    cleanup();
  });
});

describe('runBootstrapDesktopRuntimeBridge disposal races', () => {
  registerStartupHooks();

  it('releases a heal connect that resolves after cleanup', async () => {
    mocks.waitForTauri.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const healCleanup = vi.fn();
    let resolveConnect: ((cleanup: () => void) => void) | undefined;
    mocks.connect.mockImplementation(() => new Promise<() => void>((resolve) => { resolveConnect = resolve; }));

    const cleanup = await runBootstrapDesktopRuntimeBridge();
    await Promise.resolve();
    await Promise.resolve();
    cleanup();
    resolveConnect?.(healCleanup);
    await Promise.resolve();
    await Promise.resolve();

    expect(healCleanup).toHaveBeenCalledTimes(1);
  });

  it('skips connecting when the runtime disappears between ping and connect', async () => {
    mocks.isTauri.mockReturnValueOnce(true).mockReturnValue(false);
    invokeMock.mockResolvedValue('pong');

    const cleanup = await runBootstrapDesktopRuntimeBridge();

    expect(mocks.connect).not.toHaveBeenCalled();
    cleanup();
  });

  it('releases a recovery connect that resolves after cleanup', async () => {
    mocks.isTauri.mockReturnValue(true);
    let pings = 0;
    invokeMock.mockImplementation(async () => {
      pings += 1;
      if (pings <= 11) throw new Error('ipc down');
      return 'pong';
    });
    const recoveredCleanup = vi.fn();
    let resolveConnect: ((cleanup: () => void) => void) | undefined;
    mocks.connect.mockImplementation(() => new Promise<() => void>((resolve) => { resolveConnect = resolve; }));

    const cleanupPromise = runBootstrapDesktopRuntimeBridge();
    await vi.advanceTimersByTimeAsync(30_000);
    const cleanup = await cleanupPromise;
    // First background probe succeeds and starts connect; dispose before it settles.
    await vi.advanceTimersByTimeAsync(3_000);
    cleanup();
    resolveConnect?.(recoveredCleanup);
    await Promise.resolve();
    await Promise.resolve();

    expect(recoveredCleanup).toHaveBeenCalledTimes(1);
  });
});

describe('runBootstrapDesktopRuntimeBridge non-Error failures', () => {
  registerStartupHooks({ isTauri: true });

  it('stringifies non-Error ping and connect rejections', async () => {
    invokeMock.mockRejectedValue('raw ipc failure string');

    const cleanupPromise = runBootstrapDesktopRuntimeBridge();
    await vi.advanceTimersByTimeAsync(30_000);
    const cleanup = await cleanupPromise;
    cleanup();

    const ring = getRecentFrontendLogEntries();
    expect(ring.some((entry) => entry.detail?.includes('raw ipc failure string'))).toBe(true);

    // Reset for the connect variant.
    invokeMock.mockReset().mockResolvedValue('pong');
    mocks.connect.mockRejectedValue('raw connect failure');
    const secondCleanup = await runBootstrapDesktopRuntimeBridge();
    const laterRing = getRecentFrontendLogEntries();
    expect(laterRing.some((entry) => entry.detail?.includes('raw connect failure'))).toBe(true);
    secondCleanup();
  });
});

describe('runBootstrapDesktopRuntimeBridge native diagnostic gate', () => {
  registerStartupHooks({ isTauri: true });

  it('caches backend startup authority from the successful IPC ping before connecting', async () => {
    invokeMock.mockResolvedValue(
      'pong storage_status=ready watchDiagnostic=true backendAutostartAuthoritative=true',
    );

    const cleanup = await runBootstrapDesktopRuntimeBridge();

    expect(isNativeWatchDiagnosticAutostartAuthoritative()).toBe(true);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    cleanup();
  });
});

describe('runBootstrapDesktopRuntimeBridge remaining recovery arms', () => {
  registerStartupHooks();

  it('caches native diagnostic authority when IPC succeeds through background recovery', async () => {
    mocks.isTauri.mockReturnValue(true);
    let pings = 0;
    invokeMock.mockImplementation(() => {
      pings += 1;
      if (pings <= 11) return Promise.reject(new Error('startup window down'));
      return Promise.resolve(
        'pong storage_status=ready watchDiagnostic=true backendAutostartAuthoritative=true',
      );
    });

    const cleanupPromise = runBootstrapDesktopRuntimeBridge();
    await vi.advanceTimersByTimeAsync(30_000);
    const cleanup = await cleanupPromise;
    await Promise.resolve();

    expect(pings).toBeGreaterThan(11);
    expect(isNativeWatchDiagnosticAutostartAuthoritative()).toBe(true);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('stringifies a non-Error heal connect rejection', async () => {
    mocks.waitForTauri.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mocks.connect.mockRejectedValue('raw heal failure');

    const cleanup = await runBootstrapDesktopRuntimeBridge();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    const ring = getRecentFrontendLogEntries();
    expect(ring.some((entry) => entry.detail?.includes('raw heal failure'))).toBe(true);
    cleanup();
  });

  it('does not reschedule the recovery probe when a pending ping fails after cleanup', async () => {
    mocks.isTauri.mockReturnValue(true);
    let pings = 0;
    let rejectPendingPing: ((reason: unknown) => void) | undefined;
    invokeMock.mockImplementation(() => {
      pings += 1;
      if (pings <= 11) return Promise.reject(new Error('startup window down'));
      return new Promise((_resolve, reject) => { rejectPendingPing = reject; });
    });

    const cleanupPromise = runBootstrapDesktopRuntimeBridge();
    await vi.advanceTimersByTimeAsync(30_000);
    const cleanup = await cleanupPromise;
    // First background probe issues the pending ping; dispose, then fail it.
    await vi.advanceTimersByTimeAsync(2_100);
    cleanup();
    rejectPendingPing?.(new Error('too late'));
    await Promise.resolve();
    await Promise.resolve();
    const pingsAfterDispose = pings;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(pings).toBe(pingsAfterDispose);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
