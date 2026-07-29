import { emit, listen } from '@tauri-apps/api/event';
import i18n from '../../i18n/config';
import { AUDIO_RUNTIME_SNAPSHOT_EVENT, type AudioRuntimeSnapshot } from '../../schema/audio-runtime';
import type { AppConfigDraft } from '../../schema/config';
import {
  RUNTIME_NOTIFICATION_EVENT,
  RUNTIME_SNAPSHOT_EVENT,
  type RuntimeNotification,
  type RuntimeSnapshot,
} from '../../schema/runtime-core';
import { useAppStore } from '../../stores/app-store';
import { audioRuntimeSnapshotMock } from '../../defaults/audio-runtime';
import { activeDesktopApi } from '../desktop-api';
import { prewarmCaptureRoutesRuntime } from '../audio-runtime';
import { scheduleBridgeAutostartAfterStartup } from './bridge-autostart';
import { captureWarmSignature } from './capture-prewarm';
import {
  canUseLocalStorage,
  clearConfigDraftFallbackIfMatches,
  saveConfigDraftFallback,
  writeConfigDraftShadow,
  CONFIG_DRAFT_SYNC_STORAGE_KEY,
} from './config-fallback';
import { createRuntimeErrorSnapshot, formatRuntimeError } from './error-snapshot';
import { invokeWithTimeout } from './invoke';
import { pushDesktopRuntimeNotification } from './notifications';
import { markStep, type OnBootstrapStep } from './steps';
import { CONFIG_PERSIST_RETRY_EVENT, DESKTOP_RUNTIME_RETRY_EVENT } from './retry-events';

export const CONFIG_DRAFT_SYNC_EVENT = 'config://draft-updated';

/** Poll cadence used only when the audio push-event listener failed to register. */
export const AUDIO_SNAPSHOT_FALLBACK_POLL_MS = 5_000;

type RuntimeCleanup = () => void;

type PersistQueueState = {
  inflight: boolean;
  pending: AppConfigDraft | null;
  lastSerializedConfig: string;
};

// ── Core connect ──

export async function connectDesktopRuntimeBridge(onStep?: OnBootstrapStep): Promise<RuntimeCleanup> {
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

  const registerListener = async <T,>(eventName: string, handler: (event: { payload: T }) => void): Promise<boolean> => {
    try {
      trackUnlisten(await listen<T>(eventName, handler));
      return true;
    } catch (error) {
      deferDesktopRuntimeNotification(
        'warning',
        'runtime-listener-failed',
        `Runtime event listener failed (${eventName}): ${formatRuntimeError(error)}`,
      );
      return false;
    }
  };

  const fetchAudioSnapshotIntoStore = async () => {
    try {
      const snapshot = await activeDesktopApi().session.snapshot();
      if (!disposed) useAppStore.getState().setAudioRuntimeSnapshot(snapshot);
    } catch {
      // Best-effort reconciliation; the next push or poll tick retries.
    }
  };

  // The reconciliation fetch below must run after BOTH the listener
  // registration and the foreground `bootstrap_audio` write: reconciling
  // earlier lets the foreground bootstrap overwrite the fresher snapshot.
  let resolveAudioBootstrapSettled!: () => void;
  const audioBootstrapSettled = new Promise<void>((resolve) => {
    resolveAudioBootstrapSettled = resolve;
  });

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
  ]).then(async ([, , audioListenerRegistered]) => {
    await audioBootstrapSettled;
    if (disposed) return;
    if (audioListenerRegistered) {
      // Any audio push emitted between `bootstrap_audio` and this registration
      // is gone; reconcile once against the authoritative native snapshot so
      // the store cannot keep pre-registration state until the next push.
      void fetchAudioSnapshotIntoStore();
      return;
    }
    // The audio snapshot push channel is the only signal that drives watch
    // startup convergence (stream bound / lastError). Without it the session
    // UI freezes on the accepted state, so degrade to low-frequency polling
    // rather than only warning.
    const pollId = window.setInterval(() => {
      void fetchAudioSnapshotIntoStore();
    }, AUDIO_SNAPSHOT_FALLBACK_POLL_MS);
    trackUnlisten(() => window.clearInterval(pollId));
  }).finally(() => {
    flushDeferredNotifications();
  });

  markStep(onStep, 'init-runtime', 'active');
  try {
    const snapshot = await invokeWithTimeout(() => activeDesktopApi().configuration.bootstrapRuntime(), 'bootstrap_runtime');
    useAppStore.getState().setRuntimeSnapshot(snapshot);
    markStep(onStep, 'init-runtime', 'done');
  } catch (error) {
    const message = formatRuntimeError(error);
    markStep(onStep, 'init-runtime', 'error', message);
    markStep(onStep, 'init-audio', 'error', message);
    markStep(onStep, 'load-config', 'error', message);
    useAppStore.getState().setRuntimeSnapshot(createRuntimeErrorSnapshot(error));
    useAppStore.getState().setAudioRuntimeSnapshot(audioRuntimeSnapshotMock);
    resolveAudioBootstrapSettled();
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }

  let isHydrating = true;
  markStep(onStep, 'init-audio', 'active');
  markStep(onStep, 'load-config', 'active');

  let persistedConfig = useAppStore.getState().configDraft;
  let configLoadFailed = false;
  try {
    persistedConfig = await invokeWithTimeout(
      () => activeDesktopApi().configuration.load(),
      'configuration_v2.load',
    );
    useAppStore.getState().setConfigDraft(persistedConfig);
    markStep(onStep, 'load-config', 'done');
  } catch (configError) {
    configLoadFailed = true;
    const message = formatRuntimeError(configError);
    markStep(onStep, 'load-config', 'error', message);
    pushDesktopRuntimeNotification(
      'warning',
      'config-load-failed',
      i18n.language.toLowerCase().startsWith('zh')
        ? `配置读取失败，当前正在使用回退配置：${message}。可点击“重试”再次读取。`
        : `Configuration loading failed, so the fallback configuration is active: ${message}. Select Retry to load it again.`,
    );
  }

  try {
    const audioSnapshot = await invokeWithTimeout(() => activeDesktopApi().runtime.bootstrapAudio(), 'bootstrap_audio');
    useAppStore.getState().setAudioRuntimeSnapshot(audioSnapshot);
    markStep(onStep, 'init-audio', 'done', `${audioSnapshot.renderDevices.length} devices`);
  } catch (error) {
    const message = formatRuntimeError(error);
    markStep(onStep, 'init-audio', 'done', i18n.t('runtime.desktop.audioDegraded'));
    deferDesktopRuntimeNotification('warning', 'audio-bootstrap-deferred', `Audio device refresh deferred: ${message}`);
  }
  resolveAudioBootstrapSettled();

  try {
    const hydratedSnapshot = await invokeWithTimeout(() => activeDesktopApi().configuration.runtimeSnapshot(), 'get_runtime_snapshot');
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
          await activeDesktopApi().configuration.save(nextConfig);
          if (disposed) return;
          const latestSnapshot = await activeDesktopApi().configuration.runtimeSnapshot();
          if (disposed) return;
          useAppStore.getState().setRuntimeSnapshot(latestSnapshot);
          const savedSerialized = JSON.stringify(nextConfig);
          try {
            if (
              queueState.pending === null
              && JSON.stringify(useAppStore.getState().configDraft) === savedSerialized
              && canUseLocalStorage()
            ) {
              await clearConfigDraftFallbackIfMatches(savedSerialized);
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
          void saveConfigDraftFallback(nextConfig);
        } catch { /* silently fail */ }

        pushDesktopRuntimeNotification(
          'error',
          'config-persist-failed',
          i18n.language.toLowerCase().startsWith('zh')
            ? `配置未写入主存储：${lastError instanceof Error ? lastError.message : String(lastError)}。已保存本地回退副本，请点击“重试”。`
            : `The configuration was not written to primary storage: ${lastError instanceof Error ? lastError.message : String(lastError)}. A local fallback copy was saved; select Retry.`,
        );
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
      void saveConfigDraftFallback(state.configDraft);
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

  const handleConfigPersistRetry = () => {
    if (disposed) return;
    queueState.pending = useAppStore.getState().configDraft;
    void flushPersistQueue();
  };
  const handleDesktopRuntimeRetry = () => {
    if (disposed || !configLoadFailed) return;
    void (async () => {
      try {
        const config = await invokeWithTimeout(() => activeDesktopApi().configuration.load(), 'configuration_v2.load');
        useAppStore.getState().setConfigDraft(config);
        useAppStore.getState().setRuntimeSnapshot(await activeDesktopApi().configuration.runtimeSnapshot());
        configLoadFailed = false;
        markStep(onStep, 'load-config', 'done');
      } catch (error) {
        pushDesktopRuntimeNotification('error', 'config-load-retry-failed', i18n.language.toLowerCase().startsWith('zh')
          ? `配置重试仍然失败：${formatRuntimeError(error)}`
          : `Configuration retry failed again: ${formatRuntimeError(error)}`);
      }
    })();
  };
  window.addEventListener(CONFIG_PERSIST_RETRY_EVENT, handleConfigPersistRetry);
  window.addEventListener(DESKTOP_RUNTIME_RETRY_EVENT, handleDesktopRuntimeRetry);

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
      void saveConfigDraftFallback(useAppStore.getState().configDraft);
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
    window.removeEventListener(CONFIG_PERSIST_RETRY_EVENT, handleConfigPersistRetry);
    window.removeEventListener(DESKTOP_RUNTIME_RETRY_EVENT, handleDesktopRuntimeRetry);
    window.removeEventListener('storage', handleConfigDraftStorage);
    window.removeEventListener('beforeunload', handleBeforeUnload);
    unlisteners.forEach((unlisten) => unlisten());
  };
}

/** Test hooks shared with the facade; production code must not use these. */
export const connectTestHelpers = {
  invokeWithTimeout,
  createRuntimeErrorSnapshot,
  connectDesktopRuntimeBridge,
};
