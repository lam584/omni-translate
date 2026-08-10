import { useCallback, useEffect, useRef, useState } from 'react';
import { RouterProvider } from 'react-router-dom';
import BootstrapOverlay, { type BootstrapStep, type BootstrapStepStatus } from './components/BootstrapOverlay';
import WelcomeLanguagePicker from './components/welcome/WelcomeLanguagePicker';
import i18n, { getCurrentLanguage, hasCompletedWelcome } from './i18n/config';
import {
  bootstrapDesktopRuntimeBridge,
  scheduleBridgeAutostartAfterStartup,
  scheduleCapturePrewarmAfterStartup,
  type BootstrapStepId,
  type OnBootstrapStep,
} from './runtime/desktop-runtime';
import { appendFrontendDiagnosticsLog } from './runtime/diagnostics-runtime';
import { router } from './router';
import { onRouteReady } from './router-startup';
import type { AppConfigDraft } from './schema/config';
import { useAppStore } from './stores/app-store';

const STEP_LABELS: Record<BootstrapStepId, string> = {
  'detect-runtime': 'common.bootstrapDetecting',
  'check-ipc': 'common.bootstrapConnecting',
  'init-runtime': 'common.bootstrapPreparing',
  'init-audio': 'common.bootstrapPreparingAudio',
  'load-config': 'common.bootstrapLoadingConfig',
};

const STEP_ORDER: BootstrapStepId[] = [
  'detect-runtime',
  'check-ipc',
  'init-runtime',
  'init-audio',
  'load-config',
];

const DEFAULT_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID =
  'template-dashscope-realtime::qwen3.6-flash-2026-04-16';
const DEFAULT_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID =
  'template-dashscope-realtime::qwen3.5-omni-plus-realtime';
const STARTUP_MEASURE_RUN_ID = watchModeEnvString(import.meta.env, 'VITE_OMNI_STARTUP_MEASURE_RUN_ID');
const BOOTSTRAP_OVERLAY_COMPLETION_DELAY_MS = 0;
const BOOTSTRAP_HARD_TIMEOUT_MS = 45_000;
const startedWatchModeAutostartMarkers = new Set<string>();

type StartupStepTiming = {
  activeAtMs?: number;
  doneAtMs?: number;
  errorAtMs?: number;
  detail?: string;
};

function createInitialSteps(): BootstrapStep[] {
  return STEP_ORDER.map((id) => ({
    id,
    label: i18n.t(STEP_LABELS[id]),
    status: 'pending' as BootstrapStepStatus,
  }));
}

// Single implementation shared with the desktop bootstrap; re-exported here
// because this module's tests and consumers import it from App.tsx.
import { isWatchModeDiagnosticAutostartAllowed } from './runtime/bootstrap/watch-mode';
export { isWatchModeDiagnosticAutostartAllowed };

function watchModeEnvString(
  env: Record<string, string | boolean | undefined>,
  key: string,
  fallback = '',
) {
  const value = env[key];
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return fallback;
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function readPerformanceTimeOrigin() {
  return typeof performance !== 'undefined' && Number.isFinite(performance.timeOrigin)
    ? performance.timeOrigin
    : Date.now();
}

function createStartupReadyDetail(payload: Record<string, unknown>) {
  return `runId=${STARTUP_MEASURE_RUN_ID} payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

export function buildWatchModeDiagnosticAutostartConfig(
  currentConfig: AppConfigDraft,
  env: Record<string, string | boolean | undefined> = import.meta.env,
): AppConfigDraft {
  const outputDeviceId = watchModeEnvString(env, 'VITE_OMNI_WATCH_MODE_OUTPUT_DEVICE_ID');
  const outputLevel = Number(env.VITE_OMNI_WATCH_MODE_OUTPUT_LEVEL ?? currentConfig.devices.outputLevel);
  const watchModelId = watchModeEnvString(env, 'VITE_OMNI_WATCH_MODE_MODEL_ID');
  const subtitleTranslationModelId = watchModeEnvString(
    env,
    'VITE_OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID',
    DEFAULT_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID,
  );
  const inboundSecondaryAudioModelId = watchModeEnvString(
    env,
    'VITE_OMNI_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID',
    DEFAULT_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID,
  );
  const requestedSubtitleTranslationMode = watchModeEnvString(
    env,
    'VITE_OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODE',
  );
  const requestedFeedbackLoopPrevention = watchModeEnvString(
    env,
    'VITE_OMNI_WATCH_MODE_FEEDBACK_LOOP_PREVENTION',
  );
  const feedbackLoopPrevention = requestedFeedbackLoopPrevention === 'echo-cancel'
    || requestedFeedbackLoopPrevention === 'process-exclusion'
    || requestedFeedbackLoopPrevention === 'none'
    ? requestedFeedbackLoopPrevention
    : 'virtual-driver';
  // Echo-cancel must obtain a render reference from the exact audio that is
  // played locally.  A stale renderer `.env.local` must not silently turn the
  // diagnostic back into the secondary/text-only path.
  const subtitleTranslationMode = feedbackLoopPrevention === 'echo-cancel'
    ? 'native'
    : requestedSubtitleTranslationMode === 'native'
      ? 'native'
      : 'secondary';
  const textToSpeechModelId = subtitleTranslationMode === 'native'
    ? watchModelId || currentConfig.devices.inboundVoiceModelId
    : inboundSecondaryAudioModelId;
  const translationAudioSource = subtitleTranslationMode === 'native'
    ? 'omni-native'
    : 'subtitle-tts';
  const translatedSpeechEnabled = feedbackLoopPrevention !== 'none';

  return {
    ...currentConfig,
    devices: {
      ...currentConfig.devices,
      routeMode: 'watch',
      outputDeviceId: outputDeviceId || currentConfig.devices.outputDeviceId,
      outputLevel: Number.isFinite(outputLevel) ? Math.max(0, Math.min(100, outputLevel)) : currentConfig.devices.outputLevel,
      inboundVoiceModelId: watchModelId || currentConfig.devices.inboundVoiceModelId,
      outboundVoiceModelId: watchModelId || currentConfig.devices.outboundVoiceModelId,
      textToSpeechModelId,
      subtitleTranslationMode,
      subtitleTranslationModelId: subtitleTranslationMode === 'secondary' ? subtitleTranslationModelId : '',
      inboundSecondaryAudioModelId: subtitleTranslationMode === 'secondary' ? inboundSecondaryAudioModelId : '',
      outputSpeechEnabled: translatedSpeechEnabled,
      feedbackLoopPrevention,
      inboundRoute: {
        ...currentConfig.devices.inboundRoute,
        mixControl: {
          ...currentConfig.devices.inboundRoute.mixControl,
          keepOriginalAudio: true,
          translatedAudioEnabled: translatedSpeechEnabled,
          originalAudioGainDb: -4,
          translatedAudioGainDb: 0,
          translatedAudioAutoGainEnabled: true,
          duckingEnabled: true,
          monitorMode: 'original-and-translated',
        },
      },
    },
    speech: {
      ...currentConfig.speech,
      enabled: translatedSpeechEnabled,
      textToSpeechModelId,
      outputTarget: 'speaker',
      localPlaybackEnabled: translatedSpeechEnabled,
      virtualMicOutputEnabled: false,
      translationAudioSource,
    },
  };
}

async function runWatchModeDiagnosticAutostart() {
  if (!isWatchModeDiagnosticAutostartAllowed(import.meta.env)) {
    return;
  }

  const currentConfig = useAppStore.getState().configDraft;
  const config = buildWatchModeDiagnosticAutostartConfig(currentConfig);
  const runMarker = import.meta.env.VITE_OMNI_WATCH_MODE_RUN_MARKER;
  if (typeof runMarker === 'string' && startedWatchModeAutostartMarkers.has(runMarker)) {
    appendFrontendDiagnosticsLog(
      'runtime',
      'info',
      'watch_mode.diagnostic_autostart_already_started',
      `runMarker=${runMarker}`,
    );
    return;
  }
  if (typeof runMarker === 'string') {
    startedWatchModeAutostartMarkers.add(runMarker);
  }
  appendFrontendDiagnosticsLog(
    'runtime',
    'info',
    'watch_mode.diagnostic_frontend_autostart_skipped',
    `runMarker=${typeof runMarker === 'string' ? runMarker : ''} backendAutostartAuthoritative=true config=${encodeURIComponent(JSON.stringify(config))}`,
  );
}

function App() {
  const [welcomeVisible, setWelcomeVisible] = useState<boolean>(() => !hasCompletedWelcome());
  const [steps, setSteps] = useState<BootstrapStep[]>(createInitialSteps);
  const [bootstrapReady, setBootstrapReady] = useState(false);
  const startupStartedAtRef = useRef(nowMs());
  const startupStepTimingsRef = useRef<Record<string, StartupStepTiming>>({});
  const startupReadyLoggedRef = useRef(false);
  const startupReadyScheduledRef = useRef(false);
  const bridgeAutostartScheduledRef = useRef(false);
  const bridgeAutostartCleanupRef = useRef<(() => void) | null>(null);
  const bridgeAutostartPromiseRef = useRef<Promise<void> | null>(null);
  const capturePrewarmCleanupRef = useRef<(() => void) | null>(null);
  const bootstrapGenerationRef = useRef(0);
  const appMountedAtEpochMsRef = useRef<number | null>(null);
  const fullReadyLoggedRef = useRef(false);
  const deferredStylesPromiseRef = useRef<Promise<unknown> | null>(null);

  const logStartupReady = useCallback(async () => {
    if (!STARTUP_MEASURE_RUN_ID || startupReadyLoggedRef.current) {
      return;
    }

    startupReadyLoggedRef.current = true;
    const readyAtMs = Math.round(nowMs() - startupStartedAtRef.current);
    const readySignalAtEpochMs = Date.now();
    await appendFrontendDiagnosticsLog(
      'runtime',
      'info',
      'startup.readiness_ready',
      createStartupReadyDetail({
        runId: STARTUP_MEASURE_RUN_ID,
        appMountedAtEpochMs: appMountedAtEpochMsRef.current ?? Date.now(),
        readySignalAtEpochMs,
        readyAfterAppMountMs: readyAtMs,
        bootstrapOverlayCompletionDelayMs: BOOTSTRAP_OVERLAY_COMPLETION_DELAY_MS,
        timeOriginMs: Math.round(readPerformanceTimeOrigin()),
        steps: startupStepTimingsRef.current,
      }),
    );
  }, []);

  const handleBootstrapStep: OnBootstrapStep = useCallback((stepId, status, detail) => {
    const previousStepTiming = startupStepTimingsRef.current[stepId] ?? {};
    const elapsedMs = Math.round(nowMs() - startupStartedAtRef.current);
    const stepTiming: StartupStepTiming = {
      ...previousStepTiming,
      ...(status === 'active' && previousStepTiming.activeAtMs === undefined ? { activeAtMs: elapsedMs } : {}),
      ...(status === 'done' ? { doneAtMs: elapsedMs } : {}),
      ...(status === 'error' ? { errorAtMs: elapsedMs } : {}),
      ...(detail ? { detail } : {}),
    };
    startupStepTimingsRef.current[stepId] = stepTiming;

    setSteps((prev) => {
      const next = prev.map((s) =>
        s.id === stepId ? { ...s, status, detail } : s,
      );
      const allDone = next.every((s) => s.status === 'done' || s.status === 'error');
      if (allDone) {
        if (startupReadyScheduledRef.current) {
          return next;
        }
        startupReadyScheduledRef.current = true;
        setTimeout(() => {
          setBootstrapReady(true);
          void logStartupReady().then(() => {
            if (!bridgeAutostartScheduledRef.current) {
              bridgeAutostartScheduledRef.current = true;
              const scheduled = scheduleBridgeAutostartAfterStartup();
              bridgeAutostartCleanupRef.current = scheduled.cleanup;
              bridgeAutostartPromiseRef.current = scheduled.promise;
              // Warm capture devices on the same idle window so a later watch /
              // conversation click only pays `start_stream`, not the device open.
              const prewarm = scheduleCapturePrewarmAfterStartup();
              capturePrewarmCleanupRef.current = prewarm.cleanup;
            }
          });
        }, BOOTSTRAP_OVERLAY_COMPLETION_DELAY_MS);
      }
      return next;
    });
  }, [logStartupReady]);

  useEffect(() => {
    const generation = bootstrapGenerationRef.current + 1;
    bootstrapGenerationRef.current = generation;
    let disposed = false;
    let cleanup = () => {};
    const guardedBootstrapStep: OnBootstrapStep = (stepId, status, detail) => {
      if (disposed || bootstrapGenerationRef.current !== generation) {
        return;
      }
      handleBootstrapStep(stepId, status, detail);
    };
    const bootstrapHardTimeout = window.setTimeout(() => {
      if (disposed || bootstrapGenerationRef.current !== generation) return;
      const detail = (i18n.language ?? 'zh-CN').toLowerCase().startsWith('zh')
        ? '启动超过 45 秒仍未完成，已进入可恢复的降级界面。'
        : 'Startup did not finish within 45 seconds. The app entered a recoverable degraded state.';
      STEP_ORDER.forEach((stepId) => {
        const timing = startupStepTimingsRef.current[stepId];
        if (!timing || (timing.doneAtMs === undefined && timing.errorAtMs === undefined)) {
          guardedBootstrapStep(stepId, 'error', detail);
        }
      });
      useAppStore.getState().pushRuntimeNotification({
        id: `startup-timeout-${Date.now()}`,
        level: 'error',
        source: 'desktop-runtime',
        message: detail,
        emittedAt: new Date().toISOString(),
      });
      setBootstrapReady(true);
    }, BOOTSTRAP_HARD_TIMEOUT_MS);

    // 兜底：无论步骤回调是否收齐，只要整体 bootstrap 承诺已 settle 就强制关闭弹窗，
    // 避免晚订阅者漏收终态或异常路径导致进度弹窗永久卡死。
    const forceCloseOverlayOnSettle = (outcome: 'resolved' | 'rejected', error?: unknown) => {
      if (disposed || bootstrapGenerationRef.current !== generation) {
        return;
      }
      if (outcome === 'rejected') {
        const stuckStep = STEP_ORDER.find((id) => {
          const timing = startupStepTimingsRef.current[id];
          return !timing || (timing.doneAtMs === undefined && timing.errorAtMs === undefined);
        });
        void appendFrontendDiagnosticsLog(
          'runtime',
          'warning',
          'startup.bootstrap_settled_forced_overlay_close',
          `outcome=rejected stuckStep=${stuckStep ?? 'none'} error=${error instanceof Error ? error.message : String(error)}`,
        );
        setBootstrapReady(true);
        return;
      }
      // 成功 settle：仅在步骤回调未能算出 allDone（例如晚订阅者漏收终态）时兜底关闭，
      // 不抢占正常完成路径。
      if (!startupReadyScheduledRef.current) {
        setBootstrapReady(true);
      }
    };

    void bootstrapDesktopRuntimeBridge(guardedBootstrapStep).then((nextCleanup) => {
      if (disposed) {
        nextCleanup();
        return;
      }
      cleanup = nextCleanup;
      void runWatchModeDiagnosticAutostart().catch((error) => {
        void appendFrontendDiagnosticsLog(
          'runtime',
          'error',
          'watch_mode.diagnostic_autostart_failed',
          error instanceof Error ? error.message : String(error),
        );
      });
    }).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      void appendFrontendDiagnosticsLog(
        'runtime',
        'error',
        'startup.bootstrap_failed',
        detail,
      );
      useAppStore.getState().pushRuntimeNotification({
        id: `startup-bootstrap-failed-${Date.now()}`,
        level: 'error',
        source: 'desktop-runtime',
        message: (i18n.language ?? 'zh-CN').toLowerCase().startsWith('zh')
          ? `桌面运行时启动失败：${detail}`
          : `Desktop runtime startup failed: ${detail}`,
        emittedAt: new Date().toISOString(),
      });
      forceCloseOverlayOnSettle('rejected', error);
    }).finally(() => {
      window.clearTimeout(bootstrapHardTimeout);
      forceCloseOverlayOnSettle('resolved');
    });

    return () => {
      disposed = true;
      window.clearTimeout(bootstrapHardTimeout);
      if (bootstrapGenerationRef.current === generation) {
        bootstrapGenerationRef.current += 1;
      }
      bridgeAutostartCleanupRef.current?.();
      bridgeAutostartCleanupRef.current = null;
      bridgeAutostartScheduledRef.current = false;
      capturePrewarmCleanupRef.current?.();
      capturePrewarmCleanupRef.current = null;
      cleanup();
    };
  }, [handleBootstrapStep]);

  useEffect(() => {
    appMountedAtEpochMsRef.current = Date.now();
  }, []);

  // Full-ready coordinator: wait for deferred CSS + route + bridge startup convergence.
  useEffect(() => {
    if (!bootstrapReady || fullReadyLoggedRef.current) return;

    deferredStylesPromiseRef.current = Promise.resolve();

    if (!deferredStylesPromiseRef.current) return;

    let stylesResolved = false;
    let routeResolved = false;
    let bridgeResolved = false;

    const attemptFull = () => {
      if (fullReadyLoggedRef.current) return;
      if (!stylesResolved || !routeResolved || !bridgeResolved) return;
      fullReadyLoggedRef.current = true;
      void appendFrontendDiagnosticsLog('runtime', 'info', 'startup.full_ready', '');
    };

    deferredStylesPromiseRef.current.then(() => {
      stylesResolved = true;
      void appendFrontendDiagnosticsLog('runtime', 'info', 'startup.styles_ready', '');
      attemptFull();
    });

    onRouteReady();
    routeResolved = true;
    void appendFrontendDiagnosticsLog('runtime', 'info', 'startup.route_ready', '');

    if (bridgeAutostartPromiseRef.current) {
      bridgeAutostartPromiseRef.current.then(() => {
        bridgeResolved = true;
        void appendFrontendDiagnosticsLog('runtime', 'info', 'startup.bridge_converged', '');
      }).catch(() => {
        bridgeResolved = true;
        void appendFrontendDiagnosticsLog('runtime', 'info', 'startup.bridge_converged', 'convergence=error');
      }).finally(() => {
        attemptFull();
      });
    } else {
      bridgeResolved = true;
      attemptFull();
    }
  }, [bootstrapReady]);

  return (
    <>
      <RouterProvider router={router} />
      <BootstrapOverlay steps={steps} visible={!bootstrapReady} />
      {welcomeVisible && bootstrapReady ? (
        <WelcomeLanguagePicker
          initialLanguage={getCurrentLanguage()}
          onDone={() => setWelcomeVisible(false)}
        />
      ) : null}
    </>
  );
}

export default App;
