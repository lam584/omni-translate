import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
  waitForTauri: vi.fn(),
  connect: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
  isTauri: () => false,
}));

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

describe('runBootstrapDesktopRuntimeBridge state machine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.invoke.mockReset();
    mocks.isTauri.mockReset().mockReturnValue(false);
    mocks.waitForTauri.mockReset().mockResolvedValue(false);
    mocks.connect.mockReset().mockResolvedValue(() => {});
    window.localStorage.clear();
    loggerTestHelpers.reset();
    resetNativeLogForwardingForTests();
    resetDesktopApiForTests();
    useAppStore.setState((state) => ({
      ...state,
      configDraft: structuredClone(appConfigDraftMock),
      runtimeNotifications: [],
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetNativeLogForwardingForTests();
    resetDesktopApiForTests();
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
    mocks.invoke.mockResolvedValue('pong');
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
    mocks.invoke.mockResolvedValue('pong');
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
    mocks.invoke.mockImplementation(async (command: string) => {
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
    mocks.invoke.mockRejectedValue(new Error('ipc permanently down'));

    const cleanupPromise = runBootstrapDesktopRuntimeBridge();
    await vi.advanceTimersByTimeAsync(30_000);
    const cleanup = await cleanupPromise;
    // Exhaust the 60s recovery budget; afterwards no further probes fire.
    await vi.advanceTimersByTimeAsync(70_000);
    const pingsAtDeadline = mocks.invoke.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mocks.invoke.mock.calls.length).toBe(pingsAtDeadline);
    expect(mocks.connect).not.toHaveBeenCalled();
    cleanup();
  });
});

describe('runBootstrapDesktopRuntimeBridge disposal races', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.invoke.mockReset();
    mocks.isTauri.mockReset().mockReturnValue(false);
    mocks.waitForTauri.mockReset().mockResolvedValue(false);
    mocks.connect.mockReset().mockResolvedValue(() => {});
    window.localStorage.clear();
    loggerTestHelpers.reset();
    resetNativeLogForwardingForTests();
    resetDesktopApiForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetNativeLogForwardingForTests();
    resetDesktopApiForTests();
  });

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
    mocks.invoke.mockResolvedValue('pong');

    const cleanup = await runBootstrapDesktopRuntimeBridge();

    expect(mocks.connect).not.toHaveBeenCalled();
    cleanup();
  });

  it('releases a recovery connect that resolves after cleanup', async () => {
    mocks.isTauri.mockReturnValue(true);
    let pings = 0;
    mocks.invoke.mockImplementation(async () => {
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
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.invoke.mockReset();
    mocks.isTauri.mockReset().mockReturnValue(true);
    mocks.waitForTauri.mockReset().mockResolvedValue(false);
    mocks.connect.mockReset().mockResolvedValue(() => {});
    window.localStorage.clear();
    loggerTestHelpers.reset();
    resetNativeLogForwardingForTests();
    resetDesktopApiForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetNativeLogForwardingForTests();
    resetDesktopApiForTests();
  });

  it('stringifies non-Error ping and connect rejections', async () => {
    mocks.invoke.mockRejectedValue('raw ipc failure string');

    const cleanupPromise = runBootstrapDesktopRuntimeBridge();
    await vi.advanceTimersByTimeAsync(30_000);
    const cleanup = await cleanupPromise;
    cleanup();

    const ring = getRecentFrontendLogEntries();
    expect(ring.some((entry) => entry.detail?.includes('raw ipc failure string'))).toBe(true);

    // Reset for the connect variant.
    mocks.invoke.mockReset().mockResolvedValue('pong');
    mocks.connect.mockRejectedValue('raw connect failure');
    const secondCleanup = await runBootstrapDesktopRuntimeBridge();
    const laterRing = getRecentFrontendLogEntries();
    expect(laterRing.some((entry) => entry.detail?.includes('raw connect failure'))).toBe(true);
    secondCleanup();
  });
});

describe('runBootstrapDesktopRuntimeBridge remaining recovery arms', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.invoke.mockReset();
    mocks.isTauri.mockReset().mockReturnValue(false);
    mocks.waitForTauri.mockReset().mockResolvedValue(false);
    mocks.connect.mockReset().mockResolvedValue(() => {});
    window.localStorage.clear();
    loggerTestHelpers.reset();
    resetNativeLogForwardingForTests();
    resetDesktopApiForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetNativeLogForwardingForTests();
    resetDesktopApiForTests();
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
    mocks.invoke.mockImplementation(() => {
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
