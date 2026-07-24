import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { desktopApiV2 } from './desktop-api-v2';
import { prewarmCaptureRoutesRuntime, preconnectOmniRealtimeRuntime } from './audio-runtime';
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
const IPC_RECOVERY_RETRY_INTERVAL_MS = 2000;
const IPC_RECOVERY_TIMEOUT_MS = 60000;
const IPC_PING_TIMEOUT_MS = 750;
// WebView2 can expose the Tauri JavaScript bridge before its native message
// channel is ready. Keep the startup overlay in a connecting state while the
// native side settles instead of turning a recoverable launch race into a
// permanent runtime-error snapshot.
const IPC_PING_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000, 3000, 5000, 5000, 5000, 5000] as const;
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

async function pingDesktopRuntime(): Promise<number> {
  const startedAt = performance.now();
  let lastError: unknown;

  for (let attempt = 0; attempt <= IPC_PING_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await invokeWithTimeout<string>('debug_ipc_ping', IPC_PING_TIMEOUT_MS);
      return Math.round(performance.now() - startedAt);
    } catch (error) {
      lastError = error;
      const retryDelay = IPC_PING_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined) break;
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }

  throw lastError;
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

// Capture-device pre-warming runs on the same idle window as bridge autostart:
// pre-open WASAPI devices so a later watch/conversation click only pays
// `start_stream`, not the full device open. Best-effort and non-blocking.
export const CAPTURE_PREWARM_AFTER_READY_DELAY_MS = 0;

// Fields that determine which physical capture device the warmer opens. When any
// of these change we re-warm so the parked device tracks the user's selection.
function captureWarmSignature(config: AppConfigDraft): string {
  const devices = (config as { devices?: Record<string, unknown> }).devices ?? {};
  const nested = (path: string[]): unknown =>
    path.reduce<unknown>(
      (acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined),
      devices,
    );
  return JSON.stringify({
    fb: devices['feedbackLoopPrevention'] ?? null,
    inbound: nested(['inboundRoute', 'input', 'deviceId']) ?? null,
    outbound: nested(['outboundRoute', 'input', 'deviceId']) ?? null,
    virtualRender: devices['virtualRenderDeviceId'] ?? null,
    output: devices['outputDeviceId'] ?? null,
  });
}

export function scheduleCapturePrewarmAfterStartup(
  config: AppConfigDraft = useAppStore.getState().configDraft,
  delayMs = CAPTURE_PREWARM_AFTER_READY_DELAY_MS,
): { cleanup: RuntimeCleanup; promise: Promise<void> } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  const run = () => {
    void prewarmCaptureRoutesRuntime(config).finally(() => resolvePromise?.());
    // Same idle window: pre-open the Omni realtime websocket so a later watch /
    // conversation click reuses a ready session instead of paying the connect +
    // session.ready handshake on the sub-second critical path (the dominant
    // native cost measured before this change). Best-effort and idempotent: the
    // native command no-ops for non-Omni voice models and never blocks startup;
    // a config/model mismatch at click time simply falls back to connect-on-
    // demand, so there is no regression when the preconnect does not apply.
    void preconnectOmniRealtimeRuntime(config).catch(() => undefined);
  };
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

type BootstrapStepSnapshot = {
  stepId: BootstrapStepId;
  status: BootstrapStepStatus;
  detail?: string;
};

type BootstrapFlight = {
  consumers: number;
  listeners: Set<OnBootstrapStep>;
  emittedSteps: BootstrapStepSnapshot[];
  cleanup: RuntimeCleanup | null;
  promise: Promise<RuntimeCleanup>;
};

let activeBootstrapFlight: BootstrapFlight | null = null;

// Native-log forwarding is only safe once the IPC channel has been proven ready
// by a successful `debug_ipc_ping`. Firing an extra `invoke` *before* the ping
// (e.g. for the detect-runtime step) races the WebView2 native message channel
// while it is still settling and was observed to wedge the very first invoke,
// stalling startup before the ping. We therefore stay silent until the ping
// succeeds; the steps that matter for backend observability (init-runtime,
// load-config, init-audio) all occur after that point anyway.
let nativeLogForwardingEnabled = false;

export function enableNativeLogForwarding() {
  nativeLogForwardingEnabled = true;
}

// Mirror every bootstrap step transition into the native diagnostics log so the
// Rust-side app.log and the diagnostics page reflect the *frontend* startup
// state, not just the backend's. Previously the renderer owned the entire
// startup handshake and the backend log went dark after the IPC ping, which is
// exactly why a stalled `bootstrap_runtime` was invisible from the logs. This is
// fire-and-forget: it uses a trivial sync command (like `debug_ipc_ping`) and
// never blocks or throws, so it works even while a heavier invoke is stuck.
function forwardStepToNativeLog(stepId: BootstrapStepId, status: BootstrapStepStatus, detail?: string) {
  if (!isTauriRuntime() || !nativeLogForwardingEnabled) {
    return;
  }
  const level = status === 'error' ? 'error' : status === 'active' ? 'debug' : 'info';
  void invoke('append_frontend_diagnostics_log', {
    category: 'runtime',
    level,
    summary: `startup.step ${stepId}=${status}`,
    detail: detail ?? null,
  }).catch(() => {
    /* best-effort: a failed diagnostic forward must never affect startup */
  });
}

function markStep(onStep: OnBootstrapStep | undefined, stepId: BootstrapStepId, status: BootstrapStepStatus, detail?: string) {
  onStep?.(stepId, status, detail);
  forwardStepToNativeLog(stepId, status, detail);
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

  const trackUnlisten = (unlisten: RuntimeCleanup) => {
    if (disposed) {
      unlisten();
      return;
    }
    unlisteners.push(unlisten);
  };

  const registerListener = async <T,>(eventName: string, handler: (event: { payload: T }) => void) => {
    try {
      trackUnlisten(await listen<T>(eventName, handler));
    } catch (error) {
      deferDesktopRuntimeNotification(
        'warning',
        'runtime-listener-failed',
        `Runtime event listener failed (${eventName}): ${formatRuntimeError(error)}`,
      );
    }
  };

  // Runtime push-event listeners deliver *live* snapshot/notification updates.
  // They are deliberately NOT part of the startup-readiness critical path: the
  // authoritative runtime snapshot is fetched synchronously through the
  // `bootstrap_runtime` invoke below. Registering them in the foreground once
  // hard-gated startup behind `listen()`, so a WebView event channel that was
  // slow to settle left the overlay stuck at "init-runtime" forever. Register
  // them as a best-effort background task instead.
  void Promise.all([
    registerListener<RuntimeSnapshot>(RUNTIME_SNAPSHOT_EVENT, (event) => {
      useAppStore.getState().setRuntimeSnapshot(event.payload);
    }),
    registerListener<RuntimeNotification>(RUNTIME_NOTIFICATION_EVENT, (event) => {
      useAppStore.getState().pushRuntimeNotification(event.payload);
    }),
    registerListener<AudioRuntimeSnapshot>(AUDIO_RUNTIME_SNAPSHOT_EVENT, (event) => {
      useAppStore.getState().setAudioRuntimeSnapshot(event.payload);
    }),
  ]).finally(() => {
    flushDeferredNotifications();
  });

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
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }

  let isHydrating = true;
  markStep(onStep, 'init-audio', 'active');
  markStep(onStep, 'load-config', 'active');

  let persistedConfig = useAppStore.getState().configDraft;
  try {
    persistedConfig = await invokeWithTimeout<AppConfigDraft>('load_config_draft');
    useAppStore.getState().setConfigDraft(persistedConfig);
    markStep(onStep, 'load-config', 'done');
  } catch (configError) {
    const message = formatRuntimeError(configError);
    markStep(onStep, 'load-config', 'error', message);
    pushDesktopRuntimeNotification(
      'warning',
      'config-load-failed',
      `Config load failed: ${message}. Runtime and audio bootstrap state were preserved.`,
    );
  }

  try {
    const audioSnapshot = await invokeWithTimeout<AudioRuntimeSnapshot>('bootstrap_audio');
    useAppStore.getState().setAudioRuntimeSnapshot(audioSnapshot);
    markStep(onStep, 'init-audio', 'done', `${audioSnapshot.renderDevices.length} devices`);
  } catch (error) {
    const message = formatRuntimeError(error);
    markStep(onStep, 'init-audio', 'done', '已降级，稍后自动刷新设备');
    deferDesktopRuntimeNotification('warning', 'audio-bootstrap-deferred', `Audio device refresh deferred: ${message}`);
  }

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

  flushDeferredNotifications();

  isHydrating = false;

  const queueState: PersistQueueState = {
    inflight: false,
    pending: null,
    lastSerializedConfig: JSON.stringify(persistedConfig),
  };
  let isApplyingExternalConfigSync = false;
  let lastWarmSignature = captureWarmSignature(persistedConfig);

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
          const savedSerialized = JSON.stringify(nextConfig);
          try {
            if (
              queueState.pending === null
              && JSON.stringify(useAppStore.getState().configDraft) === savedSerialized
              && canUseLocalStorage()
              && window.localStorage.getItem(CONFIG_DRAFT_FALLBACK_STORAGE_KEY) === savedSerialized
            ) {
              window.localStorage.removeItem(CONFIG_DRAFT_FALLBACK_STORAGE_KEY);
            }
          } catch { /* SQLite persistence already succeeded; local cleanup is best-effort */ }
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
    try {
      if (canUseLocalStorage()) {
        window.localStorage.setItem(CONFIG_DRAFT_FALLBACK_STORAGE_KEY, sc);
      }
    } catch { /* the SQLite queue below remains the primary persistence path */ }
    void emit(CONFIG_DRAFT_SYNC_EVENT, state.configDraft).catch(() => undefined);
    queueState.pending = state.configDraft;
    void flushPersistQueue();

    // Device selection drifted: re-open the warm capture device against the new
    // target so a later click still hits the fast path. Idempotent + best-effort.
    const nextWarmSignature = captureWarmSignature(state.configDraft);
    if (nextWarmSignature !== lastWarmSignature) {
      lastWarmSignature = nextWarmSignature;
      void prewarmCaptureRoutesRuntime(state.configDraft);
    }
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
    try {
      const serialized = JSON.stringify(useAppStore.getState().configDraft);
      if (canUseLocalStorage()) {
        window.localStorage.setItem(CONFIG_DRAFT_FALLBACK_STORAGE_KEY, serialized);
      }
    } catch { /* silently fail */ }
  };
  window.addEventListener('beforeunload', handleBeforeUnload);

  // The cross-window config-sync listener carries the same stall risk as the
  // runtime push listeners above, and awaiting it here would keep the bootstrap
  // promise (and bridge autostart) pending if the event channel never settles.
  // Register it in the background and clean it up through `unlisteners`.
  void listen<AppConfigDraft>(CONFIG_DRAFT_SYNC_EVENT, (event) => {
    applyExternalConfigSync(event.payload);
  })
    .then(trackUnlisten)
    .catch((error) => {
      pushDesktopRuntimeNotification('warning', 'config-sync-listener-failed', `Config sync listener failed: ${formatRuntimeError(error)}`);
    });

  const bridgeAutostart = scheduleBridgeAutostartAfterStartup(persistedConfig);

  return () => {
    disposed = true;
    bridgeAutostart.cleanup();
    unsubscribeConfig();
    window.removeEventListener('storage', handleConfigDraftStorage);
    window.removeEventListener('beforeunload', handleBeforeUnload);
    unlisteners.forEach((unlisten) => unlisten());
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
    try {
      const fallbackData = await fallbackBackend.load<AppConfigDraft>(CONFIG_DRAFT_FALLBACK_STORAGE_KEY);
      if (fallbackData) {
        store.setConfigDraft(fallbackData);
        lastSerializedFallbackConfig = JSON.stringify(useAppStore.getState().configDraft);
      }
    } catch { /* keep mock defaults when local recovery is unavailable */ }

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
  try {
    const pingElapsedMs = await pingDesktopRuntime();
    ipcOk = true;
    // IPC is proven ready — it is now safe to mirror bootstrap steps into the
    // native diagnostics log so backend app.log reflects frontend startup.
    enableNativeLogForwarding();
    markStep(onStep, 'check-ipc', 'done', `${pingElapsedMs}ms`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[omni][desktop-runtime] debug_ipc_ping 失败:', message);
    store.setRuntimeSnapshot(createRuntimeErrorSnapshot(
      new Error(`IPC 通道诊断失败：${message}`)
    ));
    store.setAudioRuntimeSnapshot(audioRuntimeSnapshotMock);
  }

  if (!ipcOk) {
    markStep(onStep, 'check-ipc', 'error', 'IPC 通道未响应');
    markStep(onStep, 'init-runtime', 'error', 'IPC 未连通');
    markStep(onStep, 'init-audio', 'error', 'IPC 未连通');
    markStep(onStep, 'load-config', 'error', 'IPC 未连通');

    // A WebView can retain the JavaScript-side bridge while the native IPC
    // protocol is still recovering. Keep probing in the background so one
    // failed startup check does not leave the application permanently stuck
    // on the mock runtime snapshot.
    const recoveryStartedAt = Date.now();
    let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
    const recoverIpc = async () => {
      if (disposed || Date.now() - recoveryStartedAt >= IPC_RECOVERY_TIMEOUT_MS) return;
      try {
        await invokeWithTimeout<string>('debug_ipc_ping', IPC_PING_TIMEOUT_MS);
        const nextCleanup = await connectDesktopRuntimeBridge();
        if (disposed) {
          nextCleanup();
          return;
        }
        cleanup = nextCleanup;
      } catch {
        if (!disposed) recoveryTimer = setTimeout(() => void recoverIpc(), IPC_RECOVERY_RETRY_INTERVAL_MS);
      }
    };
    recoveryTimer = setTimeout(() => void recoverIpc(), IPC_RECOVERY_RETRY_INTERVAL_MS);

    return () => {
      disposed = true;
      if (recoveryTimer !== null) clearTimeout(recoveryTimer);
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
        const message = formatRuntimeError(error);
        markStep(onStep, 'init-runtime', 'error', message);
        markStep(onStep, 'init-audio', 'error', message);
        markStep(onStep, 'load-config', 'error', message);
        pushDesktopRuntimeNotification(
          'warning',
          'runtime-connect-failed',
          `Desktop runtime connect failed after IPC ping: ${message}`,
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
      // 晚订阅者立即回放已发出的步骤快照，避免只收未来步骤而漏掉终态。
      for (const snapshot of flight.emittedSteps) {
        onStep(snapshot.stepId, snapshot.status, snapshot.detail);
      }
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
    emittedSteps: [],
    cleanup: null,
    promise: Promise.resolve(() => {}),
  };
  activeBootstrapFlight = flight;

  const broadcastStep: OnBootstrapStep = (stepId, status, detail) => {
    // 记录快照，供晚订阅者加入时回放，保证其也能收齐终态。
    flight.emittedSteps.push({ stepId, status, detail });
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

