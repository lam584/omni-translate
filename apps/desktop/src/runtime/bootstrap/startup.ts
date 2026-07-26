import i18n from '../../i18n/config';
import { audioRuntimeSnapshotMock } from '../../defaults/audio-runtime';
import { runtimeSnapshotMock } from '../../defaults/runtime-shell';
import type { AppConfigDraft } from '../../schema/config';
import { useAppStore } from '../../stores/app-store';
import { activeDesktopApi, installDesktopApi, TauriDesktopApi } from '../desktop-api';
import { PreviewDesktopApi } from '../preview-desktop-api';
import { createLogger } from '../logger';
import { isTauriRuntime, waitForTauriRuntime } from '../tauri-runtime';
import { connectDesktopRuntimeBridge } from './connect';
import {
  deleteConfigDraftFallback,
  loadConfigDraftFallback,
  saveConfigDraftFallback,
} from './config-fallback';
import { createRuntimeErrorSnapshot, formatRuntimeError } from './error-snapshot';
import { invokeWithTimeout, pingDesktopRuntime, IPC_PING_TIMEOUT_MS } from './invoke';
import { enableNativeLogForwarding, markStep, type OnBootstrapStep } from './steps';

const runtimeLogger = createLogger('runtime');

const INITIAL_RUNTIME_WAIT_TIMEOUT_MS = 800;
const INITIAL_RUNTIME_WAIT_INTERVAL_MS = 25;
const LATE_RUNTIME_HEAL_TIMEOUT_MS = 15000;
const LATE_RUNTIME_HEAL_INTERVAL_MS = 100;
const IPC_RECOVERY_RETRY_INTERVAL_MS = 2000;
const IPC_RECOVERY_TIMEOUT_MS = 60000;

type RuntimeCleanup = () => void;

function pushDesktopRuntimeNotification(level: 'info' | 'warning' | 'error', idPrefix: string, message: string) {
  useAppStore.getState().pushRuntimeNotification({
    id: `${idPrefix}-${Date.now()}`,
    level,
    source: 'desktop-runtime',
    message,
    emittedAt: new Date().toISOString(),
  });
}

export async function runBootstrapDesktopRuntimeBridge(onStep?: OnBootstrapStep): Promise<RuntimeCleanup> {
  const store = useAppStore.getState();
  let disposed = false;
  let cleanup: RuntimeCleanup = () => {};
  let fallbackActive = true;
  let lastSerializedFallbackConfig = '';

  const unsubscribeFallback = useAppStore.subscribe((state, previousState) => {
    if (!fallbackActive || state.configDraft === previousState.configDraft) {
      return;
    }
    const serialized = JSON.stringify(state.configDraft);
    if (serialized === lastSerializedFallbackConfig) {
      return;
    }
    lastSerializedFallbackConfig = serialized;
    void saveConfigDraftFallback(state.configDraft);
  });

  const tauriDetected = isTauriRuntime();

  // Step 0: detect runtime
  markStep(onStep, 'detect-runtime', 'active');

  const runtimeAvailable =
    tauriDetected ||
    (await waitForTauriRuntime(INITIAL_RUNTIME_WAIT_TIMEOUT_MS, INITIAL_RUNTIME_WAIT_INTERVAL_MS));

  if (!runtimeAvailable) {
    // Tauri runtime not available — this is a browser preview scenario.
    // Install the preview boundary and proceed with its data immediately.
    installDesktopApi(new PreviewDesktopApi());
    markStep(onStep, 'detect-runtime', 'done', i18n.t('runtime.desktop.browserPreview'));
    markStep(onStep, 'check-ipc', 'done', i18n.t('runtime.desktop.skipped'));
    markStep(onStep, 'init-runtime', 'done', i18n.t('runtime.desktop.mockData'));
    markStep(onStep, 'init-audio', 'done', i18n.t('runtime.desktop.mockData'));
    markStep(onStep, 'load-config', 'done', i18n.t('runtime.desktop.mockData'));

    store.setRuntimeSnapshot(runtimeSnapshotMock);
    store.setAudioRuntimeSnapshot(audioRuntimeSnapshotMock);
    try {
      const fallbackData = await loadConfigDraftFallback();
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
      // Tauri became available later — upgrade the desktop boundary and
      // reconnect silently (no step reporting since overlay is gone).
      try {
        installDesktopApi(new TauriDesktopApi());
        const nextCleanup = await connectDesktopRuntimeBridge();
        if (disposed) {
          nextCleanup();
          return;
        }
        cleanup = nextCleanup;
      } catch (error) {
        runtimeLogger.error(
          'desktop runtime late heal failed',
          error instanceof Error ? error.message : String(error),
        );
      }
    });

    return () => {
      disposed = true;
      fallbackActive = false;
      unsubscribeFallback();
      cleanup();
    };
  }

  installDesktopApi(new TauriDesktopApi());
  markStep(onStep, 'detect-runtime', 'done', i18n.t('runtime.desktop.tauriDesktop'));

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
    runtimeLogger.error('debug_ipc_ping failed', message);
    store.setRuntimeSnapshot(createRuntimeErrorSnapshot(
      new Error(i18n.t('runtime.desktop.ipcDiagFailed', { message }))
    ));
    store.setAudioRuntimeSnapshot(audioRuntimeSnapshotMock);
  }

  if (!ipcOk) {
    markStep(onStep, 'check-ipc', 'error', i18n.t('runtime.desktop.ipcNotResponding'));
    markStep(onStep, 'init-runtime', 'error', i18n.t('runtime.desktop.ipcNotConnected'));
    markStep(onStep, 'init-audio', 'error', i18n.t('runtime.desktop.ipcNotConnected'));
    markStep(onStep, 'load-config', 'error', i18n.t('runtime.desktop.ipcNotConnected'));

    // A WebView can retain the JavaScript-side bridge while the native IPC
    // protocol is still recovering. Keep probing in the background so one
    // failed startup check does not leave the application permanently stuck
    // on the mock runtime snapshot.
    const recoveryStartedAt = Date.now();
    // Definitely assigned right below; the catch arm only reassigns it.
    let recoveryTimer!: ReturnType<typeof setTimeout>;
    const recoverIpc = async () => {
      if (disposed || Date.now() - recoveryStartedAt >= IPC_RECOVERY_TIMEOUT_MS) return;
      try {
        await invokeWithTimeout(() => activeDesktopApi().runtime.debugIpcPing(), 'debug_ipc_ping', IPC_PING_TIMEOUT_MS);
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
      clearTimeout(recoveryTimer);
      fallbackActive = false;
      unsubscribeFallback();
      cleanup();
    };
  }

  // Step 2: connect (handles init-runtime, init-audio, load-config). This
  // runs synchronously after the ping and is awaited by the caller, so no
  // dispose can interleave before it settles (unlike the heal/recovery
  // connects above, which are background tasks).
  const connectIfAvailable = async () => {
    if (!isTauriRuntime()) {
      return;
    }

    try {
      let fallbackData: AppConfigDraft | null = null;
      try {
        fallbackData = await loadConfigDraftFallback();
      } catch { /* ok */ }

      const nextCleanup = await connectDesktopRuntimeBridge(onStep);
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
          await deleteConfigDraftFallback();
        }
      } catch { /* ok */ }
    } catch (error) {
      runtimeLogger.error(
        'connectIfAvailable threw after IPC ping',
        error instanceof Error ? error.message : String(error),
      );
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
  };

  await connectIfAvailable();

  return () => {
    disposed = true;
    fallbackActive = false;
    unsubscribeFallback();
    cleanup();
  };
}
