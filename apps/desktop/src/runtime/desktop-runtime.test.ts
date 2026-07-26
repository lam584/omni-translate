import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { appConfigDraftMock } from '../mocks/app-config';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import { AUDIO_RUNTIME_SNAPSHOT_EVENT } from '../schema/audio-runtime';
import { RUNTIME_NOTIFICATION_EVENT, RUNTIME_SNAPSHOT_EVENT, type RuntimeBridgeStatus } from '../schema/runtime-core';
import { useAppStore } from '../stores/app-store';

const invokeMock = vi.fn();
const emitMock = vi.fn();
const listenMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTauri: () => Boolean((globalThis as typeof globalThis & { isTauri?: boolean }).isTauri),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emit: (...args: unknown[]) => emitMock(...args),
  listen: (...args: unknown[]) => listenMock(...args),
}));

import { bootstrapDesktopRuntimeBridge, CONFIG_DRAFT_SYNC_EVENT, desktopRuntimeTestHelpers, scheduleCapturePrewarmAfterStartup } from './desktop-runtime';
import { loggerTestHelpers } from './logger';
import { resetDesktopApiForTests } from './desktop-api';

function resetStore() {
  useAppStore.setState((state) => ({
    ...state,
    configDraft: structuredClone(appConfigDraftMock),
    runtimeSnapshot: structuredClone(runtimeSnapshotMock),
    audioRuntimeSnapshot: structuredClone(audioRuntimeSnapshotMock),
    runtimeNotifications: structuredClone(runtimeSnapshotMock.notifications),
  }));
}

function installTauriRuntime() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: { invoke: () => {} },
    configurable: true,
  });
}

type V2InvokeArgs = { command?: { action?: string } };

/** True when the call is a v2 service envelope invoke for the given action. */
function isV2(command: string, args: V2InvokeArgs | undefined, service: string, action: string) {
  return command === service && args?.command?.action === action;
}

function installHappyInvoke(snapshot = structuredClone(runtimeSnapshotMock)) {
  snapshot.bridgeStatus = 'tauri-shell';
  snapshot.storage.status = 'ready';

  invokeMock.mockImplementation(async (command: string, args?: V2InvokeArgs) => {
    if (command === 'debug_ipc_ping') {
      return 'pong storage_status=ready elapsed_ms=0';
    }

    if (command.startsWith('append_frontend_diagnostics_log')) {
      return undefined;
    }

    if (isV2(command, args, 'configuration_v2', 'bootstrapRuntime') || isV2(command, args, 'configuration_v2', 'runtimeSnapshot') || isV2(command, args, 'bridge_v2', 'refresh')) {
      return { data: snapshot, warnings: [] };
    }

    if (isV2(command, args, 'session_v2', 'bootstrap')) {
      return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
    }

    if (isV2(command, args, 'configuration_v2', 'load')) {
      return { data: structuredClone(appConfigDraftMock), warnings: [] };
    }

    if (isV2(command, args, 'configuration_v2', 'save')) {
      return { data: structuredClone(runtimeSnapshotMock.storage), warnings: [] };
    }

    if (command === 'session_v2') {
      return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
    }

    throw new Error(`unexpected command: ${command}`);
  });
}

/**
 * Ordered `command` / `command:action` names of every invoke, filtering out
 * fire-and-forget diagnostic log forwarding noise. V2 envelope calls keep
 * their action so sequence assertions stay as strict as the old per-command
 * form.
 */
function invokeCommandCalls(): string[] {
  return invokeMock.mock.calls
    .filter((call) => !String(call[0]).startsWith('append_frontend_diagnostics_log'))
    .map((call) => {
      const action = (call[1] as V2InvokeArgs | undefined)?.command?.action;
      return action ? `${call[0]}:${action}` : String(call[0]);
    });
}

describe('bootstrapDesktopRuntimeBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    emitMock.mockReset().mockResolvedValue(undefined);
    listenMock.mockReset().mockResolvedValue(() => {});
    loggerTestHelpers.reset();
    resetDesktopApiForTests();
    Reflect.deleteProperty(globalThis, 'isTauri');
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    window.localStorage.clear();
    resetStore();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'isTauri');
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('waits for a late invoke bridge before falling back to browser preview', async () => {
    const liveSnapshot = structuredClone(runtimeSnapshotMock);
    liveSnapshot.bridgeStatus = 'tauri-shell';
    liveSnapshot.activeProfileId = 'desktop-shell';
    liveSnapshot.storage.status = 'ready';
    liveSnapshot.storage.databasePath = 'C:/Users/Red/AppData/Roaming/com.omni.translate/config/omni-config.db';
    liveSnapshot.storage.credentialBackend = 'windows-credential-manager';
    liveSnapshot.notifications = [
      {
        id: 'runtime-bootstrap',
        level: 'warning',
        source: 'rust-core',
        message: '前端已建立 invoke/event 通道，主窗口与托盘就绪。字幕浮窗将在首次使用时懒加载。',
        emittedAt: 'unix:1778883200',
      },
    ];

    invokeMock.mockImplementation(async (command: string, args?: V2InvokeArgs) => {
      if (command === 'debug_ipc_ping') {
        return 'pong storage_status=ready elapsed_ms=0';
      }

      if (command.startsWith('append_frontend_diagnostics_log')) {
        return undefined;
      }

      if (isV2(command, args, 'configuration_v2', 'bootstrapRuntime')) {
        return { data: liveSnapshot, warnings: [] };
      }

      if (isV2(command, args, 'session_v2', 'bootstrap')) {
        return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      }

      if (isV2(command, args, 'configuration_v2', 'load')) {
        return { data: structuredClone(appConfigDraftMock), warnings: [] };
      }

      if (isV2(command, args, 'configuration_v2', 'save')) {
        return { data: undefined, warnings: [] };
      }

      if (isV2(command, args, 'bridge_v2', 'refresh') || isV2(command, args, 'configuration_v2', 'runtimeSnapshot')) {
        return { data: liveSnapshot, warnings: [] };
      }

      if (command === 'session_v2') {
        return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      }

      throw new Error(`unexpected command: ${command}`);
    });

    const bootstrapPromise = bootstrapDesktopRuntimeBridge();

    await vi.advanceTimersByTimeAsync(50);
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: { invoke: () => {} },
      configurable: true,
    });

    await vi.advanceTimersByTimeAsync(200);
    const cleanup = await bootstrapPromise;

    expect(invokeCommandCalls()).toEqual([
      'debug_ipc_ping',
      'configuration_v2:bootstrapRuntime',
      'configuration_v2:load',
      'session_v2:bootstrap',
      'configuration_v2:runtimeSnapshot',
      'bridge_v2:refresh',
    ]);
    expect(useAppStore.getState().runtimeSnapshot.bridgeStatus).toBe('tauri-shell');
    expect(useAppStore.getState().runtimeSnapshot.storage.status).toBe('ready');

    cleanup();
  });

  it('falls back to browser preview when no invoke bridge appears in time', async () => {
    const bootstrapPromise = bootstrapDesktopRuntimeBridge();

    await vi.advanceTimersByTimeAsync(1000);
    await bootstrapPromise;

    expect(invokeMock).not.toHaveBeenCalled();
    expect(useAppStore.getState().runtimeSnapshot.bridgeStatus).toBe('browser-preview');
  });

  it('replays already-emitted steps to a late second subscriber so it converges', async () => {
    const firstSteps: Array<[string, string]> = [];
    const secondSteps: Array<[string, string]> = [];

    // 第一个订阅者发起 bootstrap；浏览器预览等待期间 flight 处于在途状态。
    const firstBootstrap = bootstrapDesktopRuntimeBridge((stepId, status) => {
      firstSteps.push([stepId, status]);
    });

    // 首个同步步骤应已发出，此时 flight 尚未 settle。
    expect(firstSteps).toContainEqual(['detect-runtime', 'active']);

    // 第二个订阅者在途中挂载，应立即回放已发出的步骤快照。
    const secondBootstrap = bootstrapDesktopRuntimeBridge((stepId, status) => {
      secondSteps.push([stepId, status]);
    });
    expect(secondSteps).toContainEqual(['detect-runtime', 'active']);

    await vi.advanceTimersByTimeAsync(1000);
    const cleanupFirst = await firstBootstrap;
    const cleanupSecond = await secondBootstrap;

    // 晚订阅者必须收齐全部终态步骤，才能让弹窗计算出 allDone。
    const secondDoneSteps = secondSteps.filter(([, status]) => status === 'done').map(([stepId]) => stepId);
    for (const stepId of ['detect-runtime', 'check-ipc', 'init-runtime', 'init-audio', 'load-config']) {
      expect(secondDoneSteps).toContain(stepId);
    }

    cleanupFirst();
    cleanupSecond();
  });

  it('restores the locally persisted config in browser preview mode', async () => {
    const fallback = structuredClone(appConfigDraftMock);
    fallback.devices.inputLevel = 47;
    fallback.devices.feedbackLoopPrevention = 'virtual-driver';
    window.localStorage.setItem('omni.configDraftFallback', JSON.stringify(fallback));

    const bootstrapPromise = bootstrapDesktopRuntimeBridge();
    await vi.advanceTimersByTimeAsync(1000);
    const cleanup = await bootstrapPromise;

    expect(useAppStore.getState().configDraft.devices.inputLevel).toBe(47);
    expect(useAppStore.getState().configDraft.devices.feedbackLoopPrevention).toBe('virtual-driver');
    cleanup();
  });

  it('self-heals after the initial wait when the invoke bridge appears late', async () => {
    const liveSnapshot = structuredClone(runtimeSnapshotMock);
    liveSnapshot.bridgeStatus = 'tauri-shell';
    liveSnapshot.activeProfileId = 'desktop-shell';
    liveSnapshot.storage.status = 'ready';
    liveSnapshot.storage.databasePath = 'C:/Users/Red/AppData/Roaming/com.omni.translate/config/omni-config.db';
    liveSnapshot.storage.credentialBackend = 'windows-credential-manager';

    invokeMock.mockImplementation(async (command: string, args?: V2InvokeArgs) => {
      if (isV2(command, args, 'configuration_v2', 'bootstrapRuntime')) {
        return { data: liveSnapshot, warnings: [] };
      }

      if (command.startsWith('append_frontend_diagnostics_log')) {
        return undefined;
      }

      if (isV2(command, args, 'session_v2', 'bootstrap')) {
        return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      }

      if (isV2(command, args, 'configuration_v2', 'load')) {
        return { data: structuredClone(appConfigDraftMock), warnings: [] };
      }

      if (isV2(command, args, 'bridge_v2', 'refresh') || isV2(command, args, 'configuration_v2', 'runtimeSnapshot')) {
        return { data: liveSnapshot, warnings: [] };
      }

      if (isV2(command, args, 'configuration_v2', 'save')) {
        return { data: undefined, warnings: [] };
      }

      if (command === 'session_v2') {
        return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      }

      throw new Error(`unexpected command: ${command}`);
    });

    const bootstrapPromise = bootstrapDesktopRuntimeBridge();

    await vi.advanceTimersByTimeAsync(1000);
    const cleanup = await bootstrapPromise;

    expect(useAppStore.getState().runtimeSnapshot.storage.status).toBe('preview');
    expect(invokeMock).not.toHaveBeenCalled();

    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: { invoke: () => {} },
      configurable: true,
    });

    await vi.advanceTimersByTimeAsync(200);

    expect(invokeCommandCalls()).toEqual([
      'configuration_v2:bootstrapRuntime',
      'configuration_v2:load',
      'session_v2:bootstrap',
      'configuration_v2:runtimeSnapshot',
      'bridge_v2:refresh',
    ]);
    expect(useAppStore.getState().runtimeSnapshot.storage.status).toBe('ready');

    cleanup();
  });

  it('refreshes runtime snapshot after config hydration so storage becomes ready', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: { invoke: () => {} },
      configurable: true,
    });

    const bootstrapSnapshot = structuredClone(runtimeSnapshotMock);
    bootstrapSnapshot.bridgeStatus = 'tauri-shell';
    bootstrapSnapshot.activeProfileId = 'desktop-shell';
    bootstrapSnapshot.storage.status = 'preview';

    const hydratedSnapshot = structuredClone(runtimeSnapshotMock);
    hydratedSnapshot.bridgeStatus = 'tauri-shell';
    hydratedSnapshot.activeProfileId = 'desktop-shell';
    hydratedSnapshot.storage.status = 'ready';
    hydratedSnapshot.storage.databasePath = 'C:/Users/Red/AppData/Roaming/com.omni.translate/config/omni-config.db';
    hydratedSnapshot.storage.credentialBackend = 'windows-credential-manager';

    invokeMock.mockImplementation(async (command: string, args?: V2InvokeArgs) => {
      if (command === 'debug_ipc_ping') {
        return 'pong storage_status=preview elapsed_ms=0';
      }

      if (command.startsWith('append_frontend_diagnostics_log')) {
        return undefined;
      }

      if (isV2(command, args, 'configuration_v2', 'bootstrapRuntime')) {
        return { data: bootstrapSnapshot, warnings: [] };
      }

      if (isV2(command, args, 'session_v2', 'bootstrap')) {
        return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      }

      if (isV2(command, args, 'configuration_v2', 'load')) {
        return { data: structuredClone(appConfigDraftMock), warnings: [] };
      }

      if (isV2(command, args, 'bridge_v2', 'refresh') || isV2(command, args, 'configuration_v2', 'runtimeSnapshot')) {
        return { data: hydratedSnapshot, warnings: [] };
      }

      if (isV2(command, args, 'configuration_v2', 'save')) {
        return { data: undefined, warnings: [] };
      }

      if (command === 'session_v2') {
        return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      }

      throw new Error(`unexpected command: ${command}`);
    });

    const cleanup = await bootstrapDesktopRuntimeBridge();

    expect(invokeCommandCalls()).toEqual([
      'debug_ipc_ping',
      'configuration_v2:bootstrapRuntime',
      'configuration_v2:load',
      'session_v2:bootstrap',
      'configuration_v2:runtimeSnapshot',
      'bridge_v2:refresh',
    ]);
    expect(useAppStore.getState().runtimeSnapshot.storage.status).toBe('ready');

    cleanup();
  });

  it('applies config updates from cross-window storage sync without re-persisting them', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: { invoke: () => {} },
      configurable: true,
    });

    const hydratedSnapshot = structuredClone(runtimeSnapshotMock);
    hydratedSnapshot.bridgeStatus = 'tauri-shell';
    hydratedSnapshot.storage.status = 'ready';

    invokeMock.mockImplementation(async (command: string, args?: V2InvokeArgs) => {
      if (command === 'debug_ipc_ping') {
        return 'pong storage_status=ready elapsed_ms=0';
      }

      if (command.startsWith('append_frontend_diagnostics_log')) {
        return undefined;
      }

      if (isV2(command, args, 'configuration_v2', 'bootstrapRuntime')) {
        return { data: hydratedSnapshot, warnings: [] };
      }

      if (isV2(command, args, 'session_v2', 'bootstrap')) {
        return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      }

      if (isV2(command, args, 'configuration_v2', 'load')) {
        return { data: structuredClone(appConfigDraftMock), warnings: [] };
      }

      if (isV2(command, args, 'bridge_v2', 'refresh') || isV2(command, args, 'configuration_v2', 'runtimeSnapshot')) {
        return { data: hydratedSnapshot, warnings: [] };
      }

      if (isV2(command, args, 'configuration_v2', 'save')) {
        return { data: undefined, warnings: [] };
      }

      if (command === 'session_v2') {
        return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      }

      throw new Error(`unexpected command: ${command}`);
    });

    const cleanup = await bootstrapDesktopRuntimeBridge();
    const nextConfig = structuredClone(appConfigDraftMock);
    nextConfig.subtitles.overlayOpacity = 0.55;
    nextConfig.subtitles.overlayLocked = true;

    invokeMock.mockClear();
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'omni.configDraftShadow',
        newValue: JSON.stringify(nextConfig),
      }),
    );

    expect(useAppStore.getState().configDraft.subtitles.overlayOpacity).toBe(0.55);
    expect(useAppStore.getState().configDraft.subtitles.overlayLocked).toBe(true);
    expect(invokeCommandCalls()).not.toContain('configuration_v2:save');

    cleanup();
  });

  it('broadcasts config changes through a Tauri event for live overlay windows', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: { invoke: () => {} },
      configurable: true,
    });

    const hydratedSnapshot = structuredClone(runtimeSnapshotMock);
    hydratedSnapshot.bridgeStatus = 'tauri-shell';
    hydratedSnapshot.storage.status = 'ready';

    invokeMock.mockImplementation(async (command: string, args?: V2InvokeArgs) => {
      if (command === 'debug_ipc_ping') {
        return 'pong storage_status=ready elapsed_ms=0';
      }

      if (command.startsWith('append_frontend_diagnostics_log')) {
        return undefined;
      }

      if (isV2(command, args, 'configuration_v2', 'bootstrapRuntime')) {
        return { data: hydratedSnapshot, warnings: [] };
      }

      if (isV2(command, args, 'session_v2', 'bootstrap')) {
        return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      }

      if (isV2(command, args, 'configuration_v2', 'load')) {
        return { data: structuredClone(appConfigDraftMock), warnings: [] };
      }

      if (isV2(command, args, 'bridge_v2', 'refresh') || isV2(command, args, 'configuration_v2', 'runtimeSnapshot')) {
        return { data: hydratedSnapshot, warnings: [] };
      }

      if (isV2(command, args, 'configuration_v2', 'save')) {
        return { data: undefined, warnings: [] };
      }

      if (command === 'session_v2') {
        return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      }

      throw new Error(`unexpected command: ${command}`);
    });

    const cleanup = await bootstrapDesktopRuntimeBridge();

    useAppStore.getState().updateSubtitleDraft({ overlayFontSize: 34 });
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();

    expect(emitMock).toHaveBeenCalledWith(
      CONFIG_DRAFT_SYNC_EVENT,
      expect.objectContaining({
        subtitles: expect.objectContaining({ overlayFontSize: 34 }),
      }),
    );

    cleanup();
  });

  it('applies config updates from the Tauri sync event without re-persisting them', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: { invoke: () => {} },
      configurable: true,
    });

    const listeners = new Map<string, (event: { payload: unknown }) => void>();
    listenMock.mockImplementation(async (eventName: string, handler: (event: { payload: unknown }) => void) => {
      listeners.set(eventName, handler);
      return () => listeners.delete(eventName);
    });

    const hydratedSnapshot = structuredClone(runtimeSnapshotMock);
    hydratedSnapshot.bridgeStatus = 'tauri-shell';
    hydratedSnapshot.storage.status = 'ready';

    invokeMock.mockImplementation(async (command: string, args?: V2InvokeArgs) => {
      if (command === 'debug_ipc_ping') {
        return 'pong storage_status=ready elapsed_ms=0';
      }

      if (command.startsWith('append_frontend_diagnostics_log')) {
        return undefined;
      }

      if (isV2(command, args, 'configuration_v2', 'bootstrapRuntime')) {
        return { data: hydratedSnapshot, warnings: [] };
      }

      if (isV2(command, args, 'session_v2', 'bootstrap')) {
        return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      }

      if (isV2(command, args, 'configuration_v2', 'load')) {
        return { data: structuredClone(appConfigDraftMock), warnings: [] };
      }

      if (isV2(command, args, 'bridge_v2', 'refresh') || isV2(command, args, 'configuration_v2', 'runtimeSnapshot')) {
        return { data: hydratedSnapshot, warnings: [] };
      }

      if (isV2(command, args, 'configuration_v2', 'save')) {
        return { data: undefined, warnings: [] };
      }

      if (command === 'session_v2') {
        return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      }

      throw new Error(`unexpected command: ${command}`);
    });

    const cleanup = await bootstrapDesktopRuntimeBridge();
    const nextConfig = structuredClone(appConfigDraftMock);
    nextConfig.subtitles.overlayFontSize = 40;

    invokeMock.mockClear();
    listeners.get(CONFIG_DRAFT_SYNC_EVENT)?.({ payload: nextConfig });

    expect(useAppStore.getState().configDraft.subtitles.overlayFontSize).toBe(40);
    expect(invokeCommandCalls()).not.toContain('configuration_v2:save');

    cleanup();
  });

  it('applies runtime events and removes every listener during cleanup', async () => {
    installTauriRuntime();
    installHappyInvoke();
    const listeners = new Map<string, (event: { payload: never }) => void>();
    const unlisten = vi.fn();
    listenMock.mockImplementation(async (eventName: string, handler: (event: { payload: never }) => void) => {
      listeners.set(eventName, handler);
      return unlisten;
    });

    const cleanup = await bootstrapDesktopRuntimeBridge();
    const nextRuntimeSnapshot = structuredClone(runtimeSnapshotMock);
    nextRuntimeSnapshot.bridgeStatus = 'event-updated' as RuntimeBridgeStatus;
    const notification = {
      id: 'runtime-event',
      level: 'warning' as const,
      source: 'desktop-runtime',
      message: 'event received',
      emittedAt: '2026-06-01T00:00:00.000Z',
    };
    const nextAudioSnapshot = structuredClone(audioRuntimeSnapshotMock);
    nextAudioSnapshot.inbound.streamBound = true;

    listeners.get(RUNTIME_SNAPSHOT_EVENT)?.({ payload: nextRuntimeSnapshot as never });
    listeners.get(RUNTIME_NOTIFICATION_EVENT)?.({ payload: notification as never });
    listeners.get(AUDIO_RUNTIME_SNAPSHOT_EVENT)?.({ payload: nextAudioSnapshot as never });

    expect(useAppStore.getState().runtimeSnapshot.bridgeStatus).toBe('event-updated');
    expect(useAppStore.getState().runtimeNotifications).toContainEqual(notification);
    expect(useAppStore.getState().audioRuntimeSnapshot.inbound.streamBound).toBe(true);

    cleanup();
    expect(unlisten).toHaveBeenCalledTimes(4);
  });

  it('reports invalid cross-window config JSON as a runtime warning', async () => {
    installTauriRuntime();
    installHappyInvoke();

    const cleanup = await bootstrapDesktopRuntimeBridge();
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'omni.configDraftShadow',
        newValue: '{invalid',
      }),
    );

    expect(useAppStore.getState().runtimeNotifications[0]).toEqual(
      expect.objectContaining({
        level: 'warning',
        source: 'desktop-runtime',
      }),
    );
    cleanup();
  });

  it('surfaces an IPC ping failure as a degraded runtime snapshot', async () => {
    installTauriRuntime();
    invokeMock.mockRejectedValue(new Error('pipe unavailable'));

    const cleanupPromise = bootstrapDesktopRuntimeBridge();
    await vi.advanceTimersByTimeAsync(30_000);
    const cleanup = await cleanupPromise;

    expect(useAppStore.getState().runtimeSnapshot.coreState).toBe('degraded');
    expect(useAppStore.getState().runtimeSnapshot.bridgeStatus).toBe('runtime-error');
    expect(useAppStore.getState().runtimeSnapshot.notifications[0]?.source).toBe('desktop-runtime');
    cleanup();
  });

  it('recovers after the initial IPC retry window has been exhausted', async () => {
    installTauriRuntime();
    installHappyInvoke();
    let pingAttempts = 0;
    invokeMock.mockImplementation(async (command: string, args?: V2InvokeArgs) => {
      if (command === 'debug_ipc_ping') {
        pingAttempts += 1;
        if (pingAttempts <= 11) throw new Error('IPC protocol unavailable');
        return 'pong storage_status=ready elapsed_ms=0';
      }
      if (isV2(command, args, 'configuration_v2', 'bootstrapRuntime') || isV2(command, args, 'configuration_v2', 'runtimeSnapshot') || isV2(command, args, 'bridge_v2', 'refresh')) {
        return { data: structuredClone(runtimeSnapshotMock), warnings: [] };
      }
      if (isV2(command, args, 'session_v2', 'bootstrap')) return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      if (isV2(command, args, 'configuration_v2', 'load')) return { data: structuredClone(appConfigDraftMock), warnings: [] };
      throw new Error(`unexpected command: ${command}`);
    });

    const cleanupPromise = bootstrapDesktopRuntimeBridge();
    await vi.advanceTimersByTimeAsync(40_000);
    const cleanup = await cleanupPromise;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(pingAttempts).toBeGreaterThan(11);
    expect(useAppStore.getState().runtimeSnapshot.bridgeStatus).not.toBe('runtime-error');
    cleanup();
  });

  it('keeps retrying a transient IPC startup failure until the native channel recovers', async () => {
    installTauriRuntime();
    installHappyInvoke();
    let pingAttempts = 0;
    invokeMock.mockImplementation(async (command: string, args?: V2InvokeArgs) => {
      if (command === 'debug_ipc_ping') {
        pingAttempts += 1;
        if (pingAttempts < 6) throw new Error('native channel is still starting');
        return 'pong storage_status=ready elapsed_ms=0';
      }

      if (isV2(command, args, 'configuration_v2', 'bootstrapRuntime') || isV2(command, args, 'configuration_v2', 'runtimeSnapshot') || isV2(command, args, 'bridge_v2', 'refresh')) {
        return { data: structuredClone(runtimeSnapshotMock), warnings: [] };
      }

      if (isV2(command, args, 'session_v2', 'bootstrap')) return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      if (isV2(command, args, 'configuration_v2', 'load')) return { data: structuredClone(appConfigDraftMock), warnings: [] };
      throw new Error(`unexpected command: ${command}`);
    });

    const cleanupPromise = bootstrapDesktopRuntimeBridge();
    await vi.advanceTimersByTimeAsync(5_000);
    const cleanup = await cleanupPromise;

    expect(pingAttempts).toBe(6);
    expect(useAppStore.getState().runtimeSnapshot.bridgeStatus).not.toBe('runtime-error');
    cleanup();
  });

  it('reports a background driver probe failure without breaking bootstrap', async () => {
    installTauriRuntime();
    installHappyInvoke();
    invokeMock.mockImplementation(async (command: string, args?: V2InvokeArgs) => {
      if (isV2(command, args, 'bridge_v2', 'refresh')) {
        throw new Error('driver probe unavailable');
      }

      if (command === 'debug_ipc_ping') {
        return 'pong storage_status=ready elapsed_ms=0';
      }

      if (isV2(command, args, 'configuration_v2', 'bootstrapRuntime') || isV2(command, args, 'configuration_v2', 'runtimeSnapshot')) {
        return { data: structuredClone(runtimeSnapshotMock), warnings: [] };
      }

      if (isV2(command, args, 'session_v2', 'bootstrap')) {
        return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      }

      if (isV2(command, args, 'configuration_v2', 'load')) {
        return { data: structuredClone(appConfigDraftMock), warnings: [] };
      }

      throw new Error(`unexpected command: ${command}`);
    });

    const cleanup = await bootstrapDesktopRuntimeBridge();
    await Promise.resolve();

    expect(useAppStore.getState().runtimeNotifications[0]).toEqual(
      expect.objectContaining({
        level: 'warning',
        source: 'desktop-runtime',
      }),
    );
    cleanup();
  });

  it('falls back to localStorage after SQLite persistence retries are exhausted', async () => {
    installTauriRuntime();
    installHappyInvoke();
    invokeMock.mockImplementation(async (command: string, args?: V2InvokeArgs) => {
      if (isV2(command, args, 'configuration_v2', 'save')) {
        throw new Error('sqlite unavailable');
      }

      if (command === 'debug_ipc_ping') {
        return 'pong storage_status=ready elapsed_ms=0';
      }

      if (isV2(command, args, 'configuration_v2', 'bootstrapRuntime') || isV2(command, args, 'configuration_v2', 'runtimeSnapshot') || isV2(command, args, 'bridge_v2', 'refresh')) {
        return { data: structuredClone(runtimeSnapshotMock), warnings: [] };
      }

      if (isV2(command, args, 'session_v2', 'bootstrap')) {
        return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      }

      if (isV2(command, args, 'configuration_v2', 'load')) {
        return { data: structuredClone(appConfigDraftMock), warnings: [] };
      }

      throw new Error(`unexpected command: ${command}`);
    });

    const cleanup = await bootstrapDesktopRuntimeBridge();
    useAppStore.getState().updateSubtitleDraft({ overlayFontSize: 35 });
    await vi.advanceTimersByTimeAsync(4000);

    expect(JSON.parse(window.localStorage.getItem('omni.configDraftFallback') ?? '{}').subtitles.overlayFontSize).toBe(35);
    expect(useAppStore.getState().runtimeNotifications[0]).toEqual(
      expect.objectContaining({
        level: 'error',
        source: 'desktop-runtime',
      }),
    );
    cleanup();
  });

  it('reports persistence failure even when the localStorage fallback is unavailable', async () => {
    installTauriRuntime();
    installHappyInvoke();
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'omni.configDraftFallback') {
        throw new Error('storage full');
      }

      return originalSetItem.call(this, key, value);
    });
    invokeMock.mockImplementation(async (command: string, args?: V2InvokeArgs) => {
      if (isV2(command, args, 'configuration_v2', 'save')) throw 'sqlite unavailable';
      if (command === 'debug_ipc_ping') return 'pong';
      if (isV2(command, args, 'configuration_v2', 'bootstrapRuntime') || isV2(command, args, 'configuration_v2', 'runtimeSnapshot') || isV2(command, args, 'bridge_v2', 'refresh')) return { data: structuredClone(runtimeSnapshotMock), warnings: [] };
      if (isV2(command, args, 'session_v2', 'bootstrap')) return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      if (isV2(command, args, 'configuration_v2', 'load')) return { data: structuredClone(appConfigDraftMock), warnings: [] };
      throw new Error(`unexpected command: ${command}`);
    });

    const cleanup = await bootstrapDesktopRuntimeBridge();
    useAppStore.getState().updateSubtitleDraft({ overlayFontSize: 37 });
    await vi.advanceTimersByTimeAsync(4000);
    expect(window.localStorage.getItem('omni.configDraftFallback')).toBeNull();
    expect(useAppStore.getState().runtimeNotifications[0]?.message).toContain('sqlite unavailable');
    cleanup();
  });

  it('stores the pending config fallback before page unload', async () => {
    installTauriRuntime();
    installHappyInvoke();
    invokeMock.mockImplementation(async (command: string, args?: V2InvokeArgs) => {
      if (isV2(command, args, 'configuration_v2', 'save')) {
        return new Promise(() => {});
      }

      if (command === 'debug_ipc_ping') {
        return 'pong storage_status=ready elapsed_ms=0';
      }

      if (isV2(command, args, 'configuration_v2', 'bootstrapRuntime') || isV2(command, args, 'configuration_v2', 'runtimeSnapshot') || isV2(command, args, 'bridge_v2', 'refresh')) {
        return { data: structuredClone(runtimeSnapshotMock), warnings: [] };
      }

      if (isV2(command, args, 'session_v2', 'bootstrap')) {
        return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      }

      if (isV2(command, args, 'configuration_v2', 'load')) {
        return { data: structuredClone(appConfigDraftMock), warnings: [] };
      }

      throw new Error(`unexpected command: ${command}`);
    });

    const cleanup = await bootstrapDesktopRuntimeBridge();
    useAppStore.getState().updateSubtitleDraft({ overlayFontSize: 35 });
    useAppStore.getState().updateSubtitleDraft({ overlayFontSize: 36 });
    window.dispatchEvent(new Event('beforeunload'));

    expect(JSON.parse(window.localStorage.getItem('omni.configDraftFallback') ?? '{}').subtitles.overlayFontSize).toBe(36);
    cleanup();
  });

  it('mirrors an inflight config write to local recovery storage immediately', async () => {
    installTauriRuntime();
    installHappyInvoke();
    invokeMock.mockImplementation(async (command: string, args?: V2InvokeArgs) => {
      if (isV2(command, args, 'configuration_v2', 'save')) return new Promise(() => {});
      if (command === 'debug_ipc_ping') return 'pong';
      if (isV2(command, args, 'configuration_v2', 'bootstrapRuntime') || isV2(command, args, 'configuration_v2', 'runtimeSnapshot') || isV2(command, args, 'bridge_v2', 'refresh')) return { data: structuredClone(runtimeSnapshotMock), warnings: [] };
      if (isV2(command, args, 'session_v2', 'bootstrap')) return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      if (isV2(command, args, 'configuration_v2', 'load')) return { data: structuredClone(appConfigDraftMock), warnings: [] };
      throw new Error(`unexpected command: ${command}`);
    });

    const cleanup = await bootstrapDesktopRuntimeBridge();
    useAppStore.getState().updateDeviceDraft({ inputLevel: 63, feedbackLoopPrevention: 'echo-cancel' });

    const recovered = JSON.parse(window.localStorage.getItem('omni.configDraftFallback') ?? '{}');
    expect(recovered.devices.inputLevel).toBe(63);
    expect(recovered.devices.feedbackLoopPrevention).toBe('echo-cancel');
    cleanup();
  });

  it('ignores localStorage failures while flushing pending config before unload', async () => {
    installTauriRuntime();
    installHappyInvoke();
    invokeMock.mockImplementation(async (command: string, args?: V2InvokeArgs) => {
      if (isV2(command, args, 'configuration_v2', 'save')) return new Promise(() => {});
      if (command === 'debug_ipc_ping') return 'pong';
      if (isV2(command, args, 'configuration_v2', 'bootstrapRuntime') || isV2(command, args, 'configuration_v2', 'runtimeSnapshot') || isV2(command, args, 'bridge_v2', 'refresh')) return { data: structuredClone(runtimeSnapshotMock), warnings: [] };
      if (isV2(command, args, 'session_v2', 'bootstrap')) return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      if (isV2(command, args, 'configuration_v2', 'load')) return { data: structuredClone(appConfigDraftMock), warnings: [] };
      throw new Error(`unexpected command: ${command}`);
    });
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'omni.configDraftFallback') throw new Error('storage blocked');
      return originalSetItem.call(this, key, value);
    });

    const cleanup = await bootstrapDesktopRuntimeBridge();
    useAppStore.getState().updateSubtitleDraft({ overlayFontSize: 38 });
    expect(() => window.dispatchEvent(new Event('beforeunload'))).not.toThrow();
    cleanup();
  });

  it('skips unrelated and duplicate storage events', async () => {
    installTauriRuntime();
    installHappyInvoke();
    const cleanup = await bootstrapDesktopRuntimeBridge();
    const original = useAppStore.getState().configDraft;
    window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: JSON.stringify({ changed: true }) }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'omni.configDraftShadow', newValue: null }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'omni.configDraftShadow', newValue: JSON.stringify(original) }));
    expect(useAppStore.getState().configDraft).toBe(original);
    cleanup();
  });

  it('swallows config broadcast failures and reports non-error JSON parse failures', async () => {
    installTauriRuntime();
    installHappyInvoke();
    emitMock.mockRejectedValue(new Error('overlay window gone'));
    const cleanup = await bootstrapDesktopRuntimeBridge();

    useAppStore.getState().updateSubtitleDraft({ overlayFontSize: 39 });
    await Promise.resolve();
    vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw 'parse failed';
    });
    window.dispatchEvent(new StorageEvent('storage', { key: 'omni.configDraftShadow', newValue: '{invalid' }));
    expect(useAppStore.getState().runtimeNotifications[0]?.message).toContain('Cross-window config sync failed');
    cleanup();
  });

  it('does not reconnect a late runtime after cleanup', async () => {
    const cleanupPromise = bootstrapDesktopRuntimeBridge();
    await vi.advanceTimersByTimeAsync(1000);
    const cleanup = await cleanupPromise;
    cleanup();
    installTauriRuntime();
    await vi.advanceTimersByTimeAsync(200);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('flushes a config update queued behind an inflight SQLite write', async () => {
    installTauriRuntime();
    installHappyInvoke();
    let resolveFirstSave: (() => void) | undefined;
    let saveCount = 0;
    invokeMock.mockImplementation(async (command: string, args?: V2InvokeArgs) => {
      if (isV2(command, args, 'configuration_v2', 'save')) {
        saveCount += 1;
        if (saveCount === 1) {
          await new Promise<void>((resolve) => {
            resolveFirstSave = resolve;
          });
        }
        return { data: undefined, warnings: [] };
      }
      if (command === 'debug_ipc_ping') return 'pong';
      if (isV2(command, args, 'configuration_v2', 'bootstrapRuntime') || isV2(command, args, 'configuration_v2', 'runtimeSnapshot') || isV2(command, args, 'bridge_v2', 'refresh')) return { data: structuredClone(runtimeSnapshotMock), warnings: [] };
      if (isV2(command, args, 'session_v2', 'bootstrap')) return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      if (isV2(command, args, 'configuration_v2', 'load')) return { data: structuredClone(appConfigDraftMock), warnings: [] };
      throw new Error(`unexpected command: ${command}`);
    });
    const cleanup = await bootstrapDesktopRuntimeBridge();
    useAppStore.getState().updateSubtitleDraft({ overlayFontSize: 35 });
    useAppStore.getState().updateSubtitleDraft({ overlayFontSize: 36 });
    resolveFirstSave?.();
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    expect(saveCount).toBe(2);
    cleanup();
  });

  it('reports non-error background driver probe failures', async () => {
    installTauriRuntime();
    installHappyInvoke();
    invokeMock.mockImplementation(async (command: string, args?: V2InvokeArgs) => {
      if (isV2(command, args, 'bridge_v2', 'refresh')) throw 'driver probe string failure';
      if (command === 'debug_ipc_ping') return 'pong';
      if (isV2(command, args, 'configuration_v2', 'bootstrapRuntime') || isV2(command, args, 'configuration_v2', 'runtimeSnapshot')) return { data: structuredClone(runtimeSnapshotMock), warnings: [] };
      if (isV2(command, args, 'session_v2', 'bootstrap')) return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      if (isV2(command, args, 'configuration_v2', 'load')) return { data: structuredClone(appConfigDraftMock), warnings: [] };
      throw new Error(`unexpected command: ${command}`);
    });
    const cleanup = await bootstrapDesktopRuntimeBridge();
    await Promise.resolve();
    expect(useAppStore.getState().runtimeNotifications[0]?.message).toContain('driver probe string failure');
    cleanup();
  });

  it('restores a different local fallback config after connecting', async () => {
    const fallback = structuredClone(appConfigDraftMock);
    fallback.subtitles.overlayFontSize = 41;
    window.localStorage.setItem('omni.configDraftFallback', JSON.stringify(fallback));
    installTauriRuntime();
    installHappyInvoke();
    const cleanup = await bootstrapDesktopRuntimeBridge();
    expect(useAppStore.getState().configDraft.subtitles.overlayFontSize).toBe(41);
    expect(window.localStorage.getItem('omni.configDraftFallback')).toBeNull();
    cleanup();
  });
});

describe('desktop runtime helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    window.localStorage.clear();
    invokeMock.mockReset();
  });

  it('writes config shadows once and skips storage when window is unavailable', () => {
    desktopRuntimeTestHelpers.writeConfigDraftShadow('same-config');
    desktopRuntimeTestHelpers.writeConfigDraftShadow('same-config');
    expect(window.localStorage.getItem('omni.configDraftShadow')).toBe('same-config');
    vi.stubGlobal('window', undefined);
    expect(desktopRuntimeTestHelpers.canUseLocalStorage()).toBe(false);
    expect(() => desktopRuntimeTestHelpers.writeConfigDraftShadow('ignored')).not.toThrow();
  });

  it('times out invokes and creates snapshots for unknown errors', async () => {
    vi.useFakeTimers();
    const rejection = desktopRuntimeTestHelpers.invokeWithTimeout(() => new Promise(() => undefined), 'never_returns', 50).catch((error) => error);
    await vi.advanceTimersByTimeAsync(50);
    await expect(rejection).resolves.toMatchObject({ message: expect.stringContaining("invoke 'never_returns' 超时") });
    expect(desktopRuntimeTestHelpers.createRuntimeErrorSnapshot('unknown').notifications[0]?.message).toContain('未知错误');
  });

  it('resolves and rejects invoke helpers without waiting for their timeout', async () => {
    vi.useFakeTimers();
    await expect(desktopRuntimeTestHelpers.invokeWithTimeout(() => Promise.resolve('ok'), 'resolve_now', 50)).resolves.toBe('ok');
    await expect(desktopRuntimeTestHelpers.invokeWithTimeout(() => Promise.reject(new Error('invoke failed')), 'reject_now', 50)).rejects.toThrow('invoke failed');
  });
});

describe('scheduleCapturePrewarmAfterStartup', () => {
  beforeEach(() => {
    resetStore();
    invokeMock.mockReset();
    loggerTestHelpers.reset();
    resetDesktopApiForTests();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    vi.useRealTimers();
    invokeMock.mockReset();
  });

  it('cancels the pending pre-warm before its delay elapses', () => {
    installTauriRuntime();
    vi.useFakeTimers();
    invokeMock.mockResolvedValue({ data: structuredClone(audioRuntimeSnapshotMock), warnings: [] });

    const { cleanup } = scheduleCapturePrewarmAfterStartup(structuredClone(appConfigDraftMock), 5_000);
    cleanup();
    vi.advanceTimersByTime(5_000);

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('runs the pre-warm immediately with a zero delay', async () => {
    installTauriRuntime();
    invokeMock.mockResolvedValue({ data: structuredClone(audioRuntimeSnapshotMock), warnings: [] });
    const config = structuredClone(appConfigDraftMock);

    const { promise } = scheduleCapturePrewarmAfterStartup(config, 0);
    await promise;

    expect(invokeMock).toHaveBeenCalledWith('session_v2', { command: { action: 'prewarmRoutes', config } });
  });

  it('is a no-op outside the Tauri runtime', async () => {
    const { promise } = scheduleCapturePrewarmAfterStartup(structuredClone(appConfigDraftMock), 0);
    await promise;
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe('capture warm signature re-warm on device drift', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    emitMock.mockReset().mockResolvedValue(undefined);
    listenMock.mockReset().mockResolvedValue(() => {});
    loggerTestHelpers.reset();
    resetDesktopApiForTests();
    Reflect.deleteProperty(globalThis, 'isTauri');
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    window.localStorage.clear();
    resetStore();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'isTauri');
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('re-warms capture routes when a device-selection field changes', async () => {
    installTauriRuntime();
    installHappyInvoke();

    const cleanup = await bootstrapDesktopRuntimeBridge();
    invokeMock.mockClear();

    // Change a device-related field that affects the warm signature.
    useAppStore.getState().updateDeviceDraft({ feedbackLoopPrevention: 'virtual-driver' });
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();

    const sessionCalls = invokeMock.mock.calls.filter(
      ([command, args]) => command === 'session_v2' && (args as { command?: { action?: string } })?.command?.action === 'prewarmRoutes',
    );
    expect(sessionCalls.length).toBe(1);

    cleanup();
  });

  it('does not re-warm when a non-device config field changes', async () => {
    installTauriRuntime();
    installHappyInvoke();

    const cleanup = await bootstrapDesktopRuntimeBridge();
    invokeMock.mockClear();

    // Change a non-device field that does NOT affect the warm signature.
    useAppStore.getState().updateSubtitleDraft({ overlayFontSize: 42 });
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();

    const sessionCalls = invokeMock.mock.calls.filter(
      ([command, args]) => command === 'session_v2' && (args as { command?: { action?: string } })?.command?.action === 'prewarmRoutes',
    );
    expect(sessionCalls.length).toBe(0);

    cleanup();
  });

  it('re-warms when inbound device id changes', async () => {
    installTauriRuntime();
    installHappyInvoke();

    const cleanup = await bootstrapDesktopRuntimeBridge();
    invokeMock.mockClear();

    const config = structuredClone(useAppStore.getState().configDraft);
    config.devices.inboundRoute.input.deviceId = 'new-mic-device';
    useAppStore.getState().setConfigDraft(config);
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();

    const sessionCalls = invokeMock.mock.calls.filter(
      ([command, args]) => command === 'session_v2' && (args as { command?: { action?: string } })?.command?.action === 'prewarmRoutes',
    );
    expect(sessionCalls.length).toBe(1);

    cleanup();
  });
});

