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

import { bootstrapDesktopRuntimeBridge, CONFIG_DRAFT_SYNC_EVENT, desktopRuntimeTestHelpers } from './desktop-runtime';

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

function installHappyInvoke(snapshot = structuredClone(runtimeSnapshotMock)) {
  snapshot.bridgeStatus = 'tauri-shell';
  snapshot.storage.status = 'ready';

  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'debug_ipc_ping') {
      return 'pong storage_status=ready elapsed_ms=0';
    }

    if (command === 'bootstrap_runtime' || command === 'get_runtime_snapshot' || command === 'refresh_bridge_runtime') {
      return snapshot;
    }

    if (command === 'bootstrap_audio') {
      return structuredClone(audioRuntimeSnapshotMock);
    }

    if (command === 'load_config_draft') {
      return structuredClone(appConfigDraftMock);
    }

    if (command === 'save_config_draft') {
      return undefined;
    }

    throw new Error(`unexpected command: ${command}`);
  });
}

describe('bootstrapDesktopRuntimeBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    emitMock.mockReset().mockResolvedValue(undefined);
    listenMock.mockReset().mockResolvedValue(() => {});
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

    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'debug_ipc_ping') {
        return 'pong storage_status=ready elapsed_ms=0';
      }

      if (command === 'bootstrap_runtime') {
        return liveSnapshot;
      }

      if (command === 'bootstrap_audio') {
        return structuredClone(audioRuntimeSnapshotMock);
      }

      if (command === 'load_config_draft') {
        return structuredClone(appConfigDraftMock);
      }

      if (command === 'save_config_draft') {
        return undefined;
      }

      if (command === 'refresh_bridge_runtime' || command === 'get_runtime_snapshot') {
        return liveSnapshot;
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

    expect(invokeMock.mock.calls.map((call) => call[0])).toEqual([
      'debug_ipc_ping',
      'bootstrap_runtime',
      'bootstrap_audio',
      'load_config_draft',
      'get_runtime_snapshot',
      'refresh_bridge_runtime',
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

  it('self-heals after the initial wait when the invoke bridge appears late', async () => {
    const liveSnapshot = structuredClone(runtimeSnapshotMock);
    liveSnapshot.bridgeStatus = 'tauri-shell';
    liveSnapshot.activeProfileId = 'desktop-shell';
    liveSnapshot.storage.status = 'ready';
    liveSnapshot.storage.databasePath = 'C:/Users/Red/AppData/Roaming/com.omni.translate/config/omni-config.db';
    liveSnapshot.storage.credentialBackend = 'windows-credential-manager';

    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'bootstrap_runtime') {
        return liveSnapshot;
      }

      if (command === 'bootstrap_audio') {
        return structuredClone(audioRuntimeSnapshotMock);
      }

      if (command === 'load_config_draft') {
        return structuredClone(appConfigDraftMock);
      }

      if (command === 'refresh_bridge_runtime' || command === 'get_runtime_snapshot') {
        return liveSnapshot;
      }

      if (command === 'save_config_draft') {
        return undefined;
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

    expect(invokeMock.mock.calls.map((call) => call[0])).toEqual([
      'bootstrap_runtime',
      'bootstrap_audio',
      'load_config_draft',
      'get_runtime_snapshot',
      'refresh_bridge_runtime',
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

    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'debug_ipc_ping') {
        return 'pong storage_status=preview elapsed_ms=0';
      }

      if (command === 'bootstrap_runtime') {
        return bootstrapSnapshot;
      }

      if (command === 'bootstrap_audio') {
        return structuredClone(audioRuntimeSnapshotMock);
      }

      if (command === 'load_config_draft') {
        return structuredClone(appConfigDraftMock);
      }

      if (command === 'refresh_bridge_runtime' || command === 'get_runtime_snapshot') {
        return hydratedSnapshot;
      }

      if (command === 'save_config_draft') {
        return undefined;
      }

      throw new Error(`unexpected command: ${command}`);
    });

    const cleanup = await bootstrapDesktopRuntimeBridge();

    expect(invokeMock.mock.calls.map((call) => call[0])).toEqual([
      'debug_ipc_ping',
      'bootstrap_runtime',
      'bootstrap_audio',
      'load_config_draft',
      'get_runtime_snapshot',
      'refresh_bridge_runtime',
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

    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'debug_ipc_ping') {
        return 'pong storage_status=ready elapsed_ms=0';
      }

      if (command === 'bootstrap_runtime') {
        return hydratedSnapshot;
      }

      if (command === 'bootstrap_audio') {
        return structuredClone(audioRuntimeSnapshotMock);
      }

      if (command === 'load_config_draft') {
        return structuredClone(appConfigDraftMock);
      }

      if (command === 'refresh_bridge_runtime' || command === 'get_runtime_snapshot') {
        return hydratedSnapshot;
      }

      if (command === 'save_config_draft') {
        return undefined;
      }

      throw new Error(`unexpected command: ${command}`);
    });

    const cleanup = await bootstrapDesktopRuntimeBridge();
    const nextConfig = structuredClone(appConfigDraftMock);
    nextConfig.subtitles.overlayOpacity = 0.55;
    nextConfig.subtitles.overlayLocked = true;

    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'omni.configDraftShadow',
        newValue: JSON.stringify(nextConfig),
      }),
    );

    expect(useAppStore.getState().configDraft.subtitles.overlayOpacity).toBe(0.55);
    expect(useAppStore.getState().configDraft.subtitles.overlayLocked).toBe(true);
    expect(invokeMock.mock.calls.map((call) => call[0])).not.toContain('save_config_draft');

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

    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'debug_ipc_ping') {
        return 'pong storage_status=ready elapsed_ms=0';
      }

      if (command === 'bootstrap_runtime') {
        return hydratedSnapshot;
      }

      if (command === 'bootstrap_audio') {
        return structuredClone(audioRuntimeSnapshotMock);
      }

      if (command === 'load_config_draft') {
        return structuredClone(appConfigDraftMock);
      }

      if (command === 'refresh_bridge_runtime' || command === 'get_runtime_snapshot') {
        return hydratedSnapshot;
      }

      if (command === 'save_config_draft') {
        return undefined;
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

    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'debug_ipc_ping') {
        return 'pong storage_status=ready elapsed_ms=0';
      }

      if (command === 'bootstrap_runtime') {
        return hydratedSnapshot;
      }

      if (command === 'bootstrap_audio') {
        return structuredClone(audioRuntimeSnapshotMock);
      }

      if (command === 'load_config_draft') {
        return structuredClone(appConfigDraftMock);
      }

      if (command === 'refresh_bridge_runtime' || command === 'get_runtime_snapshot') {
        return hydratedSnapshot;
      }

      if (command === 'save_config_draft') {
        return undefined;
      }

      throw new Error(`unexpected command: ${command}`);
    });

    const cleanup = await bootstrapDesktopRuntimeBridge();
    const nextConfig = structuredClone(appConfigDraftMock);
    nextConfig.subtitles.overlayFontSize = 40;

    listeners.get(CONFIG_DRAFT_SYNC_EVENT)?.({ payload: nextConfig });

    expect(useAppStore.getState().configDraft.subtitles.overlayFontSize).toBe(40);
    expect(invokeMock.mock.calls.map((call) => call[0])).not.toContain('save_config_draft');

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
    invokeMock.mockRejectedValueOnce(new Error('pipe unavailable'));

    const cleanup = await bootstrapDesktopRuntimeBridge();

    expect(useAppStore.getState().runtimeSnapshot.coreState).toBe('degraded');
    expect(useAppStore.getState().runtimeSnapshot.bridgeStatus).toBe('runtime-error');
    expect(useAppStore.getState().runtimeSnapshot.notifications[0]?.source).toBe('desktop-runtime');
    cleanup();
  });

  it('reports a background driver probe failure without breaking bootstrap', async () => {
    installTauriRuntime();
    installHappyInvoke();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'refresh_bridge_runtime') {
        throw new Error('driver probe unavailable');
      }

      if (command === 'debug_ipc_ping') {
        return 'pong storage_status=ready elapsed_ms=0';
      }

      if (command === 'bootstrap_runtime' || command === 'get_runtime_snapshot') {
        return structuredClone(runtimeSnapshotMock);
      }

      if (command === 'bootstrap_audio') {
        return structuredClone(audioRuntimeSnapshotMock);
      }

      if (command === 'load_config_draft') {
        return structuredClone(appConfigDraftMock);
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
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'save_config_draft') {
        throw new Error('sqlite unavailable');
      }

      if (command === 'debug_ipc_ping') {
        return 'pong storage_status=ready elapsed_ms=0';
      }

      if (command === 'bootstrap_runtime' || command === 'get_runtime_snapshot' || command === 'refresh_bridge_runtime') {
        return structuredClone(runtimeSnapshotMock);
      }

      if (command === 'bootstrap_audio') {
        return structuredClone(audioRuntimeSnapshotMock);
      }

      if (command === 'load_config_draft') {
        return structuredClone(appConfigDraftMock);
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
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'save_config_draft') throw 'sqlite unavailable';
      if (command === 'debug_ipc_ping') return 'pong';
      if (command === 'bootstrap_runtime' || command === 'get_runtime_snapshot' || command === 'refresh_bridge_runtime') return structuredClone(runtimeSnapshotMock);
      if (command === 'bootstrap_audio') return structuredClone(audioRuntimeSnapshotMock);
      if (command === 'load_config_draft') return structuredClone(appConfigDraftMock);
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
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'save_config_draft') {
        return new Promise(() => {});
      }

      if (command === 'debug_ipc_ping') {
        return 'pong storage_status=ready elapsed_ms=0';
      }

      if (command === 'bootstrap_runtime' || command === 'get_runtime_snapshot' || command === 'refresh_bridge_runtime') {
        return structuredClone(runtimeSnapshotMock);
      }

      if (command === 'bootstrap_audio') {
        return structuredClone(audioRuntimeSnapshotMock);
      }

      if (command === 'load_config_draft') {
        return structuredClone(appConfigDraftMock);
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

  it('ignores localStorage failures while flushing pending config before unload', async () => {
    installTauriRuntime();
    installHappyInvoke();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'save_config_draft') return new Promise(() => {});
      if (command === 'debug_ipc_ping') return 'pong';
      if (command === 'bootstrap_runtime' || command === 'get_runtime_snapshot' || command === 'refresh_bridge_runtime') return structuredClone(runtimeSnapshotMock);
      if (command === 'bootstrap_audio') return structuredClone(audioRuntimeSnapshotMock);
      if (command === 'load_config_draft') return structuredClone(appConfigDraftMock);
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
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'save_config_draft') {
        saveCount += 1;
        if (saveCount === 1) {
          await new Promise<void>((resolve) => {
            resolveFirstSave = resolve;
          });
        }
        return undefined;
      }
      if (command === 'debug_ipc_ping') return 'pong';
      if (command === 'bootstrap_runtime' || command === 'get_runtime_snapshot' || command === 'refresh_bridge_runtime') return structuredClone(runtimeSnapshotMock);
      if (command === 'bootstrap_audio') return structuredClone(audioRuntimeSnapshotMock);
      if (command === 'load_config_draft') return structuredClone(appConfigDraftMock);
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
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'refresh_bridge_runtime') throw 'driver probe string failure';
      if (command === 'debug_ipc_ping') return 'pong';
      if (command === 'bootstrap_runtime' || command === 'get_runtime_snapshot') return structuredClone(runtimeSnapshotMock);
      if (command === 'bootstrap_audio') return structuredClone(audioRuntimeSnapshotMock);
      if (command === 'load_config_draft') return structuredClone(appConfigDraftMock);
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
    invokeMock.mockImplementation(() => new Promise(() => undefined));
    const rejection = desktopRuntimeTestHelpers.invokeWithTimeout('never_returns', 50).catch((error) => error);
    await vi.advanceTimersByTimeAsync(50);
    await expect(rejection).resolves.toMatchObject({ message: expect.stringContaining("invoke 'never_returns' 超时") });
    expect(desktopRuntimeTestHelpers.createRuntimeErrorSnapshot('unknown').notifications[0]?.message).toContain('未知错误');
  });

  it('resolves and rejects invoke helpers without waiting for their timeout', async () => {
    vi.useFakeTimers();
    invokeMock.mockResolvedValueOnce('ok').mockRejectedValueOnce(new Error('invoke failed'));
    await expect(desktopRuntimeTestHelpers.invokeWithTimeout('resolve_now', 50)).resolves.toBe('ok');
    await expect(desktopRuntimeTestHelpers.invokeWithTimeout('reject_now', 50)).rejects.toThrow('invoke failed');
  });
});

