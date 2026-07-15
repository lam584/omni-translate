import { emit, listen } from '@tauri-apps/api/event';
import { desktopApiV2 } from './desktop-api-v2';
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
const IPC_PING_TIMEOUT_MS = 1500;
const BRIDGE_INVOKE_TIMEOUT_MS = 8000;
export const BRIDGE_AUTOSTART_AFTER_READY_DELAY_MS = 0;
const BRIDGE_STARTUP_REFRESH_TIMEOUT_MS = 3000;
const BRIDGE_STARTUP_START_TIMEOUT_MS = 8000;

function startupRefreshTimeoutMs(): number {
  return BRIDGE_STARTUP_REFRESH_TIMEOUT_MS;
}

function startupStartTimeoutMs(): number {
  return BRIDGE_STARTUP_START_TIMEOUT_MS;
}

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

function invokeWithTimeout<T>(
  command: string,
  timeoutMs: number = BRIDGE_INVOKE_TIMEOUT_MS,
  payload?: Record<string, unknown>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`invoke '${command}' 超时（${timeoutMs}ms），IPC 通道可能未就绪或 Rust Core 未响应`));
    }, timeoutMs);

    desktopApiV2.runtime.invoke<T>(command, payload)
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

function isWatchModeAutostartRuntime() {
  const runMarker = import.meta.env.VITE_OMNI_WATCH_MODE_RUN_MARKER;
  const expiresAtMs = Number(import.meta.env.VITE_OMNI_WATCH_MODE_EXPIRES_AT_MS);
  return (
    import.meta.env.VITE_OMNI_WATCH_MODE_AUTOSTART === '1' &&
    typeof runMarker === 'string' &&
    runMarker.startsWith('watch_mode_diagnostic.run_id=') &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs > Date.now()
  );
}

function shouldAutostartBridge(snapshot: RuntimeSnapshot) {
  return (
    snapshot.bridgeStatus === 'tauri-shell' &&
    snapshot.bridge.driverHealth === 'running' &&
    (snapshot.bridge.processStatus === 'stopped' || snapshot.bridge.processStatus === 'error')
  );
}

async function refreshAndAutostartBridgeStartup(config: AppConfigDraft) {
  return _refreshAndAutostartBridge(config, startupRefreshTimeoutMs(), startupStartTimeoutMs());
}

async function _refreshAndAutostartBridge(
  config: AppConfigDraft,
  refreshTimeoutMs: number,
  startTimeoutMs: number,
) {
  try {
    const driverSnapshot = await invokeWithTimeout<RuntimeSnapshot>('refresh_bridge_runtime', refreshTimeoutMs);
    useAppStore.getState().setRuntimeSnapshot(driverSnapshot);

    if (isWatchModeAutostartRuntime() || !shouldAutostartBridge(driverSnapshot)) {
      return;
    }

    const startedSnapshot = await invokeWithTimeout<RuntimeSnapshot>(
      'start_bridge_service',
      startTimeoutMs,
      { config },
    );
    useAppStore.getState().setRuntimeSnapshot(startedSnapshot);
  } catch (error) {
    useAppStore.getState().pushRuntimeNotification({
      id: `bridge-autostart-failed-${Date.now()}`,
      level: 'warning',
      source: 'desktop-runtime',
      message: `Bridge Service 自动启动失败：${error instanceof Error ? error.message : String(error)}`,
      emittedAt: new Date().toISOString(),
    });
  }
}

export function scheduleBridgeAutostartAfterStartup(
  config: AppConfigDraft = useAppStore.getState().configDraft,
  delayMs = BRIDGE_AUTOSTART_AFTER_READY_DELAY_MS,
): { cleanup: RuntimeCleanup; promise: Promise<void> } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  const run = () => void refreshAndAutostartBridgeStartup(config).finally(() => resolvePromise?.());
  const timer = delayMs <= 0 ? null : setTimeout(run, delayMs);
  if (timer === null) {
    run();
  }

  return {
    cleanup: () => {
      if (timer !== null) clearTimeout(timer);
    },
    promise,
  };
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

// ── Bootstrap step system ──

function formatRuntimeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function pushDesktopRuntimeNotification(level: RuntimeNotification['level'], idPrefix: string, message: string) {
  useAppStore.getState().pushRuntimeNotification({
    id: `${idPrefix}-${Date.now()}`,
    level,
    source: 'desktop-runtime',
    message,
    emittedAt: new Date().toISOString(),
  });
}

export type BootstrapStepId =
  | 'detect-runtime'
  | 'check-ipc'
  | 'init-runtime'
  | 'init-audio'
  | 'load-config';

export type BootstrapStepStatus = 'active' | 'done' | 'error';

export type OnBootstrapStep = (stepId: BootstrapStepId, status: BootstrapStepStatus, detail?: string) => void;

type BootstrapFlight = {
  consumers: number;
  listeners: Set<OnBootstrapStep>;
  cleanup: RuntimeCleanup | null;
  promise: Promise<RuntimeCleanup>;
};

let activeBootstrapFlight: BootstrapFlight | null = null;

function markStep(onStep: OnBootstrapStep | undefined, stepId: BootstrapStepId, status: BootstrapStepStatus, detail?: string) {
  onStep?.(stepId, status, detail);
}

// ── Core connect ──

async function connectDesktopRuntimeBridge(onStep?: OnBootstrapStep): Promise<RuntimeCleanup> {
  let disposed = false;
  const unlisteners: RuntimeCleanup[] = [];
  const deferredNotifications: Array<{
    level: RuntimeNotification['level'];
    idPrefix: string;
    message: string;
  }> = [];

  const deferDesktopRuntimeNotification = (
    level: RuntimeNotification['level'],
    idPrefix: string,
    message: string,
  ) => {
    deferredNotifications.push({ level, idPrefix, message });
  };

  const flushDeferredNotifications = () => {
    for (const notification of deferredNotifications.splice(0)) {
      pushDesktopRuntimeNotification(notification.level, notification.idPrefix, notification.message);
    }
  };

  const registerListener = async <T,>(eventName: string, handler: (event: { payload: T }) => void) => {
    try {
      const unlisten = await listen<T>(eventName, handler);
      unlisteners.push(unlisten);
    } catch (error) {
      deferDesktopRuntimeNotification(
        'warning',
        'runtime-listener-failed',
        `Runtime event listener failed (${eventName}): ${formatRuntimeError(error)}`,
      );
    }
  };

  await Promise.all([
    registerListener<RuntimeSnapshot>(RUNTIME_SNAPSHOT_EVENT, (event) => {
      useAppStore.getState().setRuntimeSnapshot(event.payload);
    }),
    registerListener<RuntimeNotification>(RUNTIME_NOTIFICATION_EVENT, (event) => {
      useAppStore.getState().pushRuntimeNotification(event.payload);
    }),
    registerListener<AudioRuntimeSnapshot>(AUDIO_RUNTIME_SNAPSHOT_EVENT, (event) => {
      useAppStore.getState().setAudioRuntimeSnapshot(event.payload);
    }),
  ]);

  markStep(onStep, 'init-runtime', 'active');
  try {
    const snapshot = await invokeWithTimeout<RuntimeSnapshot>('bootstrap_runtime');
    useAppStore.getState().setRuntimeSnapshot(snapshot);
    markStep(onStep, 'init-runtime', 'done');
  } catch (error) {
    const message = formatRuntimeError(error);
    markStep(onStep, 'init-runtime', 'error', message);
    markStep(onStep, 'init-audio', 'error', message);
    markStep(onStep, 'load-config', 'error', message);
    useAppStore.getState().setRuntimeSnapshot(createRuntimeErrorSnapshot(error));
    useAppStore.getState().setAudioRuntimeSnapshot(audioRuntimeSnapshotMock);
    return () => {
      unlisteners.forEach((unlisten) => unlisten());
    };
  }

  markStep(onStep, 'init-audio', 'active');
  try {
    const audioSnapshot = await invokeWithTimeout<AudioRuntimeSnapshot>('bootstrap_audio');
    useAppStore.getState().setAudioRuntimeSnapshot(audioSnapshot);
    markStep(onStep, 'init-audio', 'done', `${audioSnapshot.renderDevices.length} devices`);
  } catch (error) {
    const message = formatRuntimeError(error);
    markStep(onStep, 'init-audio', 'error', message);
    deferDesktopRuntimeNotification('warning', 'audio-bootstrap-failed', `Audio runtime bootstrap failed: ${message}`);
  }

  let isHydrating = true;
  markStep(onStep, 'load-config', 'active');

  let persistedConfig: AppConfigDraft;
  try {
    persistedConfig = await invokeWithTimeout<AppConfigDraft>('load_config_draft');
    useAppStore.getState().setConfigDraft(persistedConfig);

    try {
      const hydratedSnapshot = await invokeWithTimeout<RuntimeSnapshot>('get_runtime_snapshot');
      useAppStore.getState().setRuntimeSnapshot(hydratedSnapshot);
    } catch (snapshotError) {
      pushDesktopRuntimeNotification(
        'warning',
        'runtime-snapshot-refresh-failed',
        `Runtime snapshot refresh after config load failed: ${formatRuntimeError(snapshotError)}`,
      );
    }

    markStep(onStep, 'load-config', 'done');
  } catch (configError) {
    const message = formatRuntimeError(configError);
    markStep(onStep, 'load-config', 'error', message);
    pushDesktopRuntimeNotification(
      'warning',
      'config-load-failed',
      `Config load failed: ${message}. Runtime and audio bootstrap state were preserved.`,
    );
    persistedConfig = useAppStore.getState().configDraft;
  }

  flushDeferredNotifications();

  isHydrating = false;

  const queueState: PersistQueueState = {
    inflight: false,
    pending: null,
    lastSerializedConfig: JSON.stringify(persistedConfig),
  };
  let isApplyingExternalConfigSync = false;

  writeConfigDraftShadow(queueState.lastSerializedConfig);

  const applyExternalConfigSync = (nextConfig: AppConfigDraft) => {
    const sc = JSON.stringify(nextConfig);
    if (sc === queueState.lastSerializedConfig) return;
    isApplyingExternalConfigSync = true;
    try {
      useAppStore.getState().setConfigDraft(nextConfig);
      queueState.lastSerializedConfig = JSON.stringify(useAppStore.getState().configDraft);
      writeConfigDraftShadow(queueState.lastSerializedConfig);
    } finally {
      isApplyingExternalConfigSync = false;
    }
  };

  const flushPersistQueue = async () => {
    if (disposed || queueState.inflight || queueState.pending === null) return;
    queueState.inflight = true;
    const nextConfig = queueState.pending;
    queueState.pending = null;
    const retryDelays = [500, 1000, 2000];
    let lastError: unknown;

    try {
      for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
        if (disposed) return;
        try {
          await desktopApiV2.runtime.invoke('save_config_draft', { config: nextConfig });
          if (disposed) return;
          const latestSnapshot = await desktopApiV2.runtime.invoke<RuntimeSnapshot>('get_runtime_snapshot');
          if (disposed) return;
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

      if (lastError && !disposed) {
        try {
          const serialized = JSON.stringify(nextConfig);
          if (canUseLocalStorage()) {
            window.localStorage.setItem(CONFIG_DRAFT_FALLBACK_STORAGE_KEY, serialized);
          }
        } catch { /* silently fail */ }

        useAppStore.getState().pushRuntimeNotification({
          id: `config-persist-failed-${Date.now()}`,
          level: 'error',
          source: 'desktop-runtime',
          message: `Config write to SQLite failed: ${lastError instanceof Error ? lastError.message : String(lastError)}. Saved a localStorage fallback.`,
          emittedAt: new Date().toISOString(),
        });
      }
    } finally {
      queueState.inflight = false;
      if (!disposed && queueState.pending !== null) void flushPersistQueue();
    }
  };

  const unsubscribeConfig = useAppStore.subscribe((state, previousState) => {
    if (isHydrating || isApplyingExternalConfigSync || state.configDraft === previousState.configDraft) return;
    const sc = JSON.stringify(state.configDraft);
    if (sc === queueState.lastSerializedConfig) return;
    queueState.lastSerializedConfig = sc;
    writeConfigDraftShadow(sc);
    void emit(CONFIG_DRAFT_SYNC_EVENT, state.configDraft).catch(() => undefined);
    queueState.pending = state.configDraft;
    void flushPersistQueue();
  });

  const handleConfigDraftStorage = (event: StorageEvent) => {
    if (event.key !== CONFIG_DRAFT_SYNC_STORAGE_KEY || !event.newValue) return;
    if (event.newValue === queueState.lastSerializedConfig) return;
    try {
      applyExternalConfigSync(JSON.parse(event.newValue) as AppConfigDraft);
    } catch (error) {
      pushDesktopRuntimeNotification('warning', 'config-sync-failed', `Cross-window config sync failed: ${formatRuntimeError(error)}`);
    }
  };

  window.addEventListener('storage', handleConfigDraftStorage);

  const handleBeforeUnload = () => {
    if (queueState.pending !== null) {
      try {
        const serialized = JSON.stringify(queueState.pending);
        if (canUseLocalStorage()) {
          window.localStorage.setItem(CONFIG_DRAFT_FALLBACK_STORAGE_KEY, serialized);
        }
      } catch { /* silently fail */ }
    }
  };
  window.addEventListener('beforeunload', handleBeforeUnload);

  let unlistenConfigDraft: RuntimeCleanup = () => {};
  try {
    unlistenConfigDraft = await listen<AppConfigDraft>(CONFIG_DRAFT_SYNC_EVENT, (event) => {
      applyExternalConfigSync(event.payload);
    });
  } catch (error) {
    pushDesktopRuntimeNotification('warning', 'config-sync-listener-failed', `Config sync listener failed: ${formatRuntimeError(error)}`);
  }

  const bridgeAutostart = scheduleBridgeAutostartAfterStartup(persistedConfig);

  return () => {
    disposed = true;
    bridgeAutostart.cleanup();
    unsubscribeConfig();
    window.removeEventListener('storage', handleConfigDraftStorage);
    window.removeEventListener('beforeunload', handleBeforeUnload);
    unlisteners.forEach((unlisten) => unlisten());
    unlistenConfigDraft();
  };
}

export const desktopRuntimeTestHelpers = {
  canUseLocalStorage,
  writeConfigDraftShadow,
  invokeWithTimeout,
  createRuntimeErrorSnapshot,
  connectDesktopRuntimeBridge,
};

async function runBootstrapDesktopRuntimeBridge(onStep?: OnBootstrapStep): Promise<RuntimeCleanup> {
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

  // Step 0: detect runtime
  markStep(onStep, 'detect-runtime', 'active');

  const runtimeAvailable =
    tauriDetected ||
    (await waitForTauriRuntime(INITIAL_RUNTIME_WAIT_TIMEOUT_MS, INITIAL_RUNTIME_WAIT_INTERVAL_MS));

  if (!runtimeAvailable) {
    // Tauri runtime not available — this is a browser preview scenario.
    // Report it clearly and proceed with mock data immediately.
    markStep(onStep, 'detect-runtime', 'done', '浏览器预览模式');
    markStep(onStep, 'check-ipc', 'done', '已跳过');
    markStep(onStep, 'init-runtime', 'done', 'Mock 数据');
    markStep(onStep, 'init-audio', 'done', 'Mock 数据');
    markStep(onStep, 'load-config', 'done', 'Mock 数据');

    store.setRuntimeSnapshot(runtimeSnapshotMock);
    store.setAudioRuntimeSnapshot(audioRuntimeSnapshotMock);

    // Still attempt late healing in background — but don't block.
    void waitForTauriRuntime(LATE_RUNTIME_HEAL_TIMEOUT_MS, LATE_RUNTIME_HEAL_INTERVAL_MS).then(async (available) => {
      if (!available || disposed) {
        return;
      }
      // Tauri became available later — reconnect silently (no step reporting since overlay is gone).
      try {
        const nextCleanup = await connectDesktopRuntimeBridge();
        if (disposed) {
          nextCleanup();
          return;
        }
        cleanup = nextCleanup;
      } catch (error) {
        console.error('[omni][desktop-runtime] late heal failed:', error);
      }
    });

    return () => {
      disposed = true;
      fallbackActive = false;
      unsubscribeFallback();
      cleanup();
    };
  }

  markStep(onStep, 'detect-runtime', 'done', 'Tauri 桌面环境');

  // Step 1: check IPC
  markStep(onStep, 'check-ipc', 'active');

  let ipcOk = false;
  const pingStart = performance.now();
  try {
    const pingResult = await invokeWithTimeout<string>('debug_ipc_ping', IPC_PING_TIMEOUT_MS);
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
    markStep(onStep, 'check-ipc', 'done', `${Math.round(performance.now() - pingStart)}ms`);
  } else {
    markStep(onStep, 'check-ipc', 'error', 'IPC 通道未响应');
    markStep(onStep, 'init-runtime', 'error', 'IPC 未连通');
    markStep(onStep, 'init-audio', 'error', 'IPC 未连通');
    markStep(onStep, 'load-config', 'error', 'IPC 未连通');

    return () => {
      disposed = true;
      fallbackActive = false;
      unsubscribeFallback();
      cleanup();
    };
  }

  // Step 2: connect (handles init-runtime, init-audio, load-config)
  const connectIfAvailable = async () => {
    if (disposed || !isTauriRuntime()) {
      return;
    }

    try {
      let fallbackData: AppConfigDraft | null = null;
      try {
        fallbackData = await fallbackBackend.load<AppConfigDraft>(CONFIG_DRAFT_FALLBACK_STORAGE_KEY);
      } catch { /* ok */ }

      const nextCleanup = await connectDesktopRuntimeBridge(onStep);
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
      } catch { /* ok */ }
    } catch (error) {
      console.error('[omni][desktop-runtime] connectIfAvailable 异常:', error);
      if (!disposed) {
        pushDesktopRuntimeNotification(
          'warning',
          'runtime-connect-failed',
          `Desktop runtime connect failed after IPC ping: ${formatRuntimeError(error)}`,
        );
      }
    }
  };

  await connectIfAvailable();

  return () => {
    disposed = true;
    fallbackActive = false;
    unsubscribeFallback();
    cleanup();
  };
}

export async function bootstrapDesktopRuntimeBridge(onStep?: OnBootstrapStep): Promise<RuntimeCleanup> {
  if (activeBootstrapFlight) {
    const flight = activeBootstrapFlight;
    flight.consumers += 1;
    if (onStep) {
      flight.listeners.add(onStep);
    }

    await flight.promise;

    return () => {
      if (onStep) {
        flight.listeners.delete(onStep);
      }
      flight.consumers -= 1;
      if (flight.consumers <= 0) {
        flight.cleanup?.();
        if (activeBootstrapFlight === flight) {
          activeBootstrapFlight = null;
        }
      }
    };
  }

  const listeners = new Set<OnBootstrapStep>();
  if (onStep) {
    listeners.add(onStep);
  }

  const flight: BootstrapFlight = {
    consumers: 1,
    listeners,
    cleanup: null,
    promise: Promise.resolve(() => {}),
  };
  activeBootstrapFlight = flight;

  const broadcastStep: OnBootstrapStep = (stepId, status, detail) => {
    for (const listener of Array.from(flight.listeners)) {
      listener(stepId, status, detail);
    }
  };

  flight.promise = runBootstrapDesktopRuntimeBridge(broadcastStep)
    .then((cleanup) => {
      flight.cleanup = cleanup;
      if (activeBootstrapFlight === flight) {
        activeBootstrapFlight = null;
      }
      if (flight.consumers <= 0) {
        cleanup();
      }
      return cleanup;
    })
    .catch((error) => {
      if (activeBootstrapFlight === flight) {
        activeBootstrapFlight = null;
      }
      throw error;
    });

  await flight.promise;

  return () => {
    if (onStep) {
      flight.listeners.delete(onStep);
    }
    flight.consumers -= 1;
    if (flight.consumers <= 0) {
      flight.cleanup?.();
      if (activeBootstrapFlight === flight) {
        activeBootstrapFlight = null;
      }
    }
  };
}

