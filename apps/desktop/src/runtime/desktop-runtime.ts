import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import { AUDIO_RUNTIME_SNAPSHOT_EVENT, type AudioRuntimeSnapshot } from '../schema/audio-runtime';
import type { AppConfigDraft } from '../schema/config';
import {
  RUNTIME_NOTIFICATION_EVENT,
  RUNTIME_SNAPSHOT_EVENT,
  type RuntimeNotification,
  type RuntimeSnapshot,
} from '../schema/runtime-core';
import { useAppStore } from '../stores/app-store';
import { isTauriRuntime, waitForTauriRuntime } from './tauri-runtime';
import { LocalStorageBackend } from '../utils/persistence-backend';

type RuntimeCleanup = () => void;

type PersistQueueState = {
  inflight: boolean;
  pending: AppConfigDraft | null;
  lastSerializedConfig: string;
};

const INITIAL_RUNTIME_WAIT_TIMEOUT_MS = 800;
const INITIAL_RUNTIME_WAIT_INTERVAL_MS = 25;
const LATE_RUNTIME_HEAL_TIMEOUT_MS = 15000;
const LATE_RUNTIME_HEAL_INTERVAL_MS = 100;
const BRIDGE_INVOKE_TIMEOUT_MS = 8000;
const DRIVER_PROBE_TIMEOUT_MS = 120000;
const CONFIG_DRAFT_SYNC_STORAGE_KEY = 'omni.configDraftShadow';
const CONFIG_DRAFT_FALLBACK_STORAGE_KEY = 'omni.configDraftFallback';
export const CONFIG_DRAFT_SYNC_EVENT = 'config://draft-updated';

function canUseLocalStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function writeConfigDraftShadow(serializedConfig: string) {
  if (!canUseLocalStorage()) {
    return;
  }

  if (window.localStorage.getItem(CONFIG_DRAFT_SYNC_STORAGE_KEY) === serializedConfig) {
    return;
  }

  window.localStorage.setItem(CONFIG_DRAFT_SYNC_STORAGE_KEY, serializedConfig);
}

function invokeWithTimeout<T>(command: string, timeoutMs: number = BRIDGE_INVOKE_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`invoke '${command}' 超时（${timeoutMs}ms），IPC 通道可能未就绪或 Rust Core 未响应`));
    }, timeoutMs);

    invoke<T>(command)
      .then((result) => {
        clearTimeout(timeoutId);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

function createRuntimeErrorSnapshot(error: unknown): RuntimeSnapshot {
  const message = error instanceof Error ? error.message : '未知错误';

  return {
    ...runtimeSnapshotMock,
    coreState: 'degraded',
    bridgeStatus: 'runtime-error',
    lastSyncAt: new Date().toISOString(),
    notifications: [
      {
        id: 'runtime-bootstrap-failed',
        level: 'error',
        source: 'desktop-runtime',
        message: `Rust Core 启动桥接失败：${message}`,
        emittedAt: new Date().toISOString(),
      },
    ],
  };
}

async function connectDesktopRuntimeBridge(): Promise<RuntimeCleanup> {
  const store = useAppStore.getState();

  try {
    const snapshot = await invokeWithTimeout<RuntimeSnapshot>('bootstrap_runtime');
    store.setRuntimeSnapshot(snapshot);
    const audioSnapshot = await invokeWithTimeout<AudioRuntimeSnapshot>('bootstrap_audio');
    store.setAudioRuntimeSnapshot(audioSnapshot);
    const unlistenSnapshot = await listen<RuntimeSnapshot>(RUNTIME_SNAPSHOT_EVENT, (event) => {
      useAppStore.getState().setRuntimeSnapshot(event.payload);
    });

    const unlistenNotification = await listen<RuntimeNotification>(RUNTIME_NOTIFICATION_EVENT, (event) => {
      useAppStore.getState().pushRuntimeNotification(event.payload);
    });

    const unlistenAudioSnapshot = await listen<AudioRuntimeSnapshot>(AUDIO_RUNTIME_SNAPSHOT_EVENT, (event) => {
      useAppStore.getState().setAudioRuntimeSnapshot(event.payload);
    });

    let isHydrating = true;
    const persistedConfig = await invokeWithTimeout<AppConfigDraft>('load_config_draft');
    store.setConfigDraft(persistedConfig);
    const hydratedSnapshot = await invokeWithTimeout<RuntimeSnapshot>('get_runtime_snapshot');
    store.setRuntimeSnapshot(hydratedSnapshot);
    void invokeWithTimeout<RuntimeSnapshot>('refresh_bridge_runtime', DRIVER_PROBE_TIMEOUT_MS)
      .then((driverSnapshot) => useAppStore.getState().setRuntimeSnapshot(driverSnapshot))
      .catch((error) => {
        useAppStore.getState().pushRuntimeNotification({
          id: `driver-probe-failed-${Date.now()}`,
          level: 'warning',
          source: 'desktop-runtime',
          message: `驱动检测失败：${error instanceof Error ? error.message : String(error)}`,
          emittedAt: new Date().toISOString(),
        });
      });
    isHydrating = false;

    const queueState: PersistQueueState = {
      inflight: false,
      pending: null,
      lastSerializedConfig: JSON.stringify(persistedConfig),
    };
    let isApplyingExternalConfigSync = false;

    writeConfigDraftShadow(queueState.lastSerializedConfig);

    const applyExternalConfigSync = (nextConfig: AppConfigDraft) => {
      const serializedConfig = JSON.stringify(nextConfig);
      if (serializedConfig === queueState.lastSerializedConfig) {
        return;
      }

      isApplyingExternalConfigSync = true;
      try {
        useAppStore.getState().setConfigDraft(nextConfig);
        queueState.lastSerializedConfig = JSON.stringify(useAppStore.getState().configDraft);
        writeConfigDraftShadow(queueState.lastSerializedConfig);
      } finally {
        isApplyingExternalConfigSync = false;
      }
    };

    // Persist queue flush: writes configDraft to SQLite via IPC.
    // - Retries up to 3 times with exponential backoff (500/1000/2000ms)
    // - Falls back to localStorage (omni.configDraftFallback) if all IPC retries fail
    // - Only one in-flight write at a time (inflight flag guards concurrency)
    const flushPersistQueue = async () => {
      if (queueState.inflight || queueState.pending === null) {
        return;
      }

      queueState.inflight = true;
      const nextConfig = queueState.pending;
      queueState.pending = null;

      const retryDelays = [500, 1000, 2000];
      let lastError: unknown;

      try {
        for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
          try {
            await invoke('save_config_draft', { config: nextConfig });
            const latestSnapshot = await invoke<RuntimeSnapshot>('get_runtime_snapshot');
            useAppStore.getState().setRuntimeSnapshot(latestSnapshot);
            lastError = undefined;
            break;
          } catch (error) {
            lastError = error;
            if (attempt < retryDelays.length) {
              await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
            }
          }
        }

        if (lastError) {
          try {
            const serialized = JSON.stringify(nextConfig);
            if (canUseLocalStorage()) {
              window.localStorage.setItem(CONFIG_DRAFT_FALLBACK_STORAGE_KEY, serialized);
            }
          } catch {
            // Silently fail
          }

          useAppStore.getState().pushRuntimeNotification({
            id: `config-persist-failed-${Date.now()}`,
            level: 'error',
            source: 'desktop-runtime',
            message: `配置写入 SQLite 失败：${lastError instanceof Error ? lastError.message : '未知错误'}，已将配置保存至 localStorage 作为后备方案`,
            emittedAt: new Date().toISOString(),
          });
        }
      } finally {
        queueState.inflight = false;
        if (queueState.pending !== null) {
          void flushPersistQueue();
        }
      }
    };

    // Subscribes to all configDraft changes and queues them for persistence.
    // This captures: provider, linkedProviders, devices, subtitles, speech,
    // driver, glossary, diagnostics, onboarding — any field mutated via
    // updateXxxDraft() is automatically persisted.
    // EPHEMERAL fields (runtimeSnapshot, audioRuntimeSnapshot, activePageId)
    // are NOT captured by this subscription — they are intentionally not persisted.
    const unsubscribeConfig = useAppStore.subscribe((state, previousState) => {
      if (isHydrating || isApplyingExternalConfigSync || state.configDraft === previousState.configDraft) {
        return;
      }

      const serializedConfig = JSON.stringify(state.configDraft);
      if (serializedConfig === queueState.lastSerializedConfig) {
        return;
      }

      queueState.lastSerializedConfig = serializedConfig;
      writeConfigDraftShadow(serializedConfig);
      void emit(CONFIG_DRAFT_SYNC_EVENT, state.configDraft).catch(() => undefined);
      queueState.pending = state.configDraft;
      void flushPersistQueue();
    });

    const handleConfigDraftStorage = (event: StorageEvent) => {
      if (event.key !== CONFIG_DRAFT_SYNC_STORAGE_KEY || !event.newValue) {
        return;
      }

      if (event.newValue === queueState.lastSerializedConfig) {
        return;
      }

      try {
        applyExternalConfigSync(JSON.parse(event.newValue) as AppConfigDraft);
      } catch (error) {
        useAppStore.getState().pushRuntimeNotification({
          id: `config-sync-failed-${Date.now()}`,
          level: 'warning',
          source: 'desktop-runtime',
          message: `跨窗口配置同步失败：${error instanceof Error ? error.message : '未知错误'}`,
          emittedAt: new Date().toISOString(),
        });
      }
    };

    window.addEventListener('storage', handleConfigDraftStorage);

    // Flush any pending config changes to localStorage before page close.
    // This prevents data loss if the IPC write hasn't completed yet.
    const handleBeforeUnload = () => {
      if (queueState.pending !== null) {
        try {
          const serialized = JSON.stringify(queueState.pending);
          if (canUseLocalStorage()) {
            window.localStorage.setItem(CONFIG_DRAFT_FALLBACK_STORAGE_KEY, serialized);
          }
        } catch {
          // Silently fail
        }
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    const unlistenConfigDraft = await listen<AppConfigDraft>(CONFIG_DRAFT_SYNC_EVENT, (event) => {
      applyExternalConfigSync(event.payload);
    });

    return () => {
      unsubscribeConfig();
      window.removeEventListener('storage', handleConfigDraftStorage);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      unlistenSnapshot();
      unlistenNotification();
      unlistenAudioSnapshot();
      unlistenConfigDraft();
    };
  } catch (error) {
    store.setRuntimeSnapshot(createRuntimeErrorSnapshot(error));
    store.setAudioRuntimeSnapshot(audioRuntimeSnapshotMock);
    return () => {};
  }
}

export const desktopRuntimeTestHelpers = {
  canUseLocalStorage,
  writeConfigDraftShadow,
  invokeWithTimeout,
  createRuntimeErrorSnapshot,
  connectDesktopRuntimeBridge,
};

export async function bootstrapDesktopRuntimeBridge(): Promise<RuntimeCleanup> {
  const store = useAppStore.getState();
  let disposed = false;
  let cleanup: RuntimeCleanup = () => {};
  let fallbackActive = true;
  let lastSerializedFallbackConfig = '';
  const fallbackBackend = new LocalStorageBackend();

  const unsubscribeFallback = useAppStore.subscribe((state, previousState) => {
    if (!fallbackActive || state.configDraft === previousState.configDraft) {
      return;
    }

    const serialized = JSON.stringify(state.configDraft);
    if (serialized === lastSerializedFallbackConfig) {
      return;
    }

    lastSerializedFallbackConfig = serialized;
    void fallbackBackend.save(CONFIG_DRAFT_FALLBACK_STORAGE_KEY, state.configDraft);
  });

  const tauriDetected = isTauriRuntime();
  console.log('[omni][desktop-runtime] bootstrapDesktopRuntimeBridge 开始，isTauriRuntime=', tauriDetected);

  const runtimeAvailable =
    tauriDetected ||
    (await waitForTauriRuntime(INITIAL_RUNTIME_WAIT_TIMEOUT_MS, INITIAL_RUNTIME_WAIT_INTERVAL_MS));

  console.log('[omni][desktop-runtime] runtimeAvailable=', runtimeAvailable);

  const connectIfAvailable = async () => {
    if (disposed || !isTauriRuntime()) {
      return;
    }

    try {
      let fallbackData: AppConfigDraft | null = null;
      try {
        fallbackData = await fallbackBackend.load<AppConfigDraft>(CONFIG_DRAFT_FALLBACK_STORAGE_KEY);
      } catch {
        // Fallback recovery failure should not block bridge connection.
      }
      const nextCleanup = await connectDesktopRuntimeBridge();
      if (disposed) {
        nextCleanup();
        return;
      }

      cleanup = nextCleanup;

      try {
        fallbackActive = false;
        unsubscribeFallback();

        if (fallbackData) {
          const storeNow = useAppStore.getState();
          const currentSerialized = JSON.stringify(storeNow.configDraft);
          const storedSerialized = JSON.stringify(fallbackData);
          if (storedSerialized !== currentSerialized) {
            storeNow.setConfigDraft(fallbackData);
          }
          await fallbackBackend.delete(CONFIG_DRAFT_FALLBACK_STORAGE_KEY);
        }
      } catch {
        // Fallback sync failure should not break bridge connection
      }
    } catch (error) {
      console.error('[omni][desktop-runtime] connectIfAvailable 异常:', error);
      if (!disposed) {
        store.setRuntimeSnapshot(createRuntimeErrorSnapshot(error));
        store.setAudioRuntimeSnapshot(audioRuntimeSnapshotMock);
      }
    }
  };

  if (runtimeAvailable) {
    let ipcOk = false;
    try {
      const pingResult = await invokeWithTimeout<string>('debug_ipc_ping', BRIDGE_INVOKE_TIMEOUT_MS);
      console.log('[omni][desktop-runtime] debug_ipc_ping 成功:', pingResult);
      ipcOk = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[omni][desktop-runtime] debug_ipc_ping 失败:', message);
      store.setRuntimeSnapshot(createRuntimeErrorSnapshot(
        new Error(`IPC 通道诊断失败：${message}`)
      ));
      store.setAudioRuntimeSnapshot(audioRuntimeSnapshotMock);
    }

    if (ipcOk) {
      await connectIfAvailable();
    }
  } else {
    store.setRuntimeSnapshot(runtimeSnapshotMock);
    store.setAudioRuntimeSnapshot(audioRuntimeSnapshotMock);

    void waitForTauriRuntime(LATE_RUNTIME_HEAL_TIMEOUT_MS, LATE_RUNTIME_HEAL_INTERVAL_MS).then(async (available) => {
      if (!available || disposed) {
        return;
      }

      await connectIfAvailable();
    });
  }

  return () => {
    disposed = true;
    fallbackActive = false;
    unsubscribeFallback();
    cleanup();
  };
}
