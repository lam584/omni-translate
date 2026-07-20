import type { AppConfigDraft } from '../../schema/config';
import type { RuntimeSnapshot } from '../../schema/runtime-core';
import type { RuntimeNotification } from '../../schema/runtime-core';
import type { AudioRuntimeSnapshot } from '../../schema/audio-runtime';
import {
  cancelOmniPreconnectRuntime,
  getAudioRuntimeSnapshotRuntime,
  preconnectOmniRealtimeRuntime,
  showSubtitleOverlayWindow,
  startAudioRouteRuntime,
  waitForWatchRouteReadyRuntime,
  startSpeechDispatchRuntime,
  startTranslateWorkerRuntime,
  stopAudioRouteRuntime,
  stopSpeechDispatchRuntime,
  stopTranslateWorkerRuntime,
} from '../../runtime/audio-runtime';
import { appendFrontendDiagnosticsLog } from '../../runtime/diagnostics-runtime';
import { useDesktopApiV2 } from '../../runtime/desktop-api-context';
import type { SceneMode } from '../../utils/scene-readiness';
import { watchModeNeedsBridge } from '../../utils/scene-readiness';
import { stringifyRedacted } from '../../utils/redact-sensitive-data';
import { buildSceneLaunchPlan, buildWatchFallbackPlan, type SceneLaunchStage } from './sceneLaunchPlan';
import { executeSceneLaunchPlan, SceneLaunchError } from './sceneLaunchExecutor';
import { sceneLaunchTimeoutMs } from './sceneLaunchTimeout';

type SceneSessionControllerOptions = {
  runtimeSnapshot: RuntimeSnapshot;
  setRuntimeSnapshot: (snapshot: RuntimeSnapshot) => void;
  setAudioSnapshot: (snapshot: AudioRuntimeSnapshot) => void;
  updateDeviceDraft: (patch: Partial<AppConfigDraft['devices']>) => void;
  updateSpeechDraft: (patch: Partial<AppConfigDraft['speech']>) => void;
  updateDiagnosticsReady: (mode: SceneMode) => void;
  pushNotification: (notification: RuntimeNotification) => void;
  runBusyAction: BusyActionRunner;
  confirmWatchFallback: () => boolean;
  sceneLaunchFailureMessage: (mode: SceneMode, stage: string | null, error: unknown) => string;
  sceneLaunchTimeoutMessage: (seconds: number) => string;
};

type BusyActionRunner = (action: 'watch-start' | 'conversation-start' | 'stop', task: () => Promise<void>) => Promise<void>;

type SceneLaunchOptions = {
  mode: SceneMode;
  configDraft: AppConfigDraft;
  audioSnapshot: AudioRuntimeSnapshot;
  overlayVisible: boolean;
  isOmniModel: boolean;
  speechPatch: Partial<AppConfigDraft['speech']> & { enabled: boolean };
  secondarySubtitleTranslationEnabled: boolean;
};

function sceneLaunchTimeoutError(message: string) {
  return new Error(message);
}

async function withSceneLaunchTimeout<T>(operation: Promise<T>, timeoutMs: number, timeoutMessage: string, onTimeout: () => Promise<void>): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => {
      void onTimeout().catch((error) => {
        appendFrontendDiagnosticsLog('runtime', 'warning', `[SceneLaunch] timeout cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      reject(sceneLaunchTimeoutError(timeoutMessage));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timerId !== null) clearTimeout(timerId);
  }
}

function isBridgeStartupError(error: unknown) {
  const lower = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
  return ['bridge', 'driver', 'source pipe', 'virtual', 'sysvad', 'package', 'wasapi'].some((token) => lower.includes(token));
}

/** Coordinates the Bridge readiness sequence used before scene startup. */
export function useSceneSessionController(controller: SceneSessionControllerOptions) {
  const { runtimeSnapshot, setRuntimeSnapshot } = controller;
  const desktopApi = useDesktopApiV2();
  const ensureBridgeReady = async (mode: SceneMode, nextConfig: AppConfigDraft): Promise<RuntimeSnapshot> => {
    if (!watchModeNeedsBridge(nextConfig)) {
      return runtimeSnapshot;
    }

    // Bridge convergence is already scheduled during application bootstrap.
    // Never install/repair/restart it synchronously from the sub-second watch
    // launch path; start_audio_route performs a cheap pipe health check and
    // reports an immediately actionable error if prewarming did not succeed.
    if (mode === 'watch') {
      return runtimeSnapshot;
    }

    let latestRuntime: RuntimeSnapshot;
    try {
      latestRuntime = await desktopApi.bridge.refresh();
      setRuntimeSnapshot(latestRuntime);
    } catch (refreshError) {
      appendFrontendDiagnosticsLog(
        'runtime',
        'warning',
        `[BridgeReady] refresh failed, proceeding with cached snapshot: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`,
      );
      latestRuntime = runtimeSnapshot;
    }

    if (latestRuntime.bridge.driverHealth === 'not-installed') {
      const installed = await desktopApi.bridge.install(nextConfig);
      setRuntimeSnapshot(installed);
      return installed;
    }
    if (latestRuntime.bridge.driverHealth !== 'running') {
      const repairAction = latestRuntime.bridge.recommendedAction === 'rollback-driver'
        ? 'rollback-driver' as const
        : latestRuntime.bridge.recommendedAction === 'restart-bridge'
          ? 'restart-bridge' as const
          : 'reinstall-driver' as const;
      latestRuntime = await desktopApi.bridge.repair(repairAction, nextConfig);
      setRuntimeSnapshot(latestRuntime);
    }
    if (latestRuntime.bridge.bridgeState !== 'running') {
      const started = await desktopApi.bridge.start(nextConfig);
      setRuntimeSnapshot(started);
      return started;
    }
    return latestRuntime;
  };

  const stopAll = async ({
    audioSnapshot,
    hasSpeechActivity,
    setAudioSnapshot,
    pushNotification,
    runBusyAction,
  }: {
    audioSnapshot: AudioRuntimeSnapshot;
    hasSpeechActivity: boolean;
    setAudioSnapshot: (snapshot: AudioRuntimeSnapshot) => void;
    pushNotification: (notification: RuntimeNotification) => void;
    runBusyAction: (action: 'stop', task: () => Promise<void>) => Promise<void>;
  }) => {
    await runBusyAction('stop', async () => {
      let nativeSnapshot = audioSnapshot;
      try {
        nativeSnapshot = await getAudioRuntimeSnapshotRuntime();
        setAudioSnapshot(nativeSnapshot);
      } catch (error) {
        appendFrontendDiagnosticsLog('runtime', 'warning', `[StopAll] native snapshot refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const inboundBound = nativeSnapshot.inbound.streamBound;
      const outboundBound = nativeSnapshot.outbound.streamBound;
      const nativeSpeechActivity = nativeSnapshot.speech.dispatchState !== 'idle';
      setAudioSnapshot({
        ...nativeSnapshot,
        inbound: inboundBound
          ? { ...nativeSnapshot.inbound, streamBound: false, captureState: 'stopping' }
          : nativeSnapshot.inbound,
        outbound: outboundBound
          ? { ...nativeSnapshot.outbound, streamBound: false, captureState: 'stopping' }
          : nativeSnapshot.outbound,
        speech: {
          ...nativeSnapshot.speech,
          dispatchState: nativeSpeechActivity || hasSpeechActivity ? 'idle' : nativeSnapshot.speech.dispatchState,
        },
      });

      const stopStep = async (label: string, action: () => Promise<AudioRuntimeSnapshot>) => {
        try {
          setAudioSnapshot(await action());
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          appendFrontendDiagnosticsLog('runtime', 'error', `[StopAll] ${label} stop failed: ${detail}`);
          pushNotification({
            id: `stop-${label}-${Date.now()}`,
            level: 'error',
            source: 'session',
            message: `停止 ${label} 失败：${detail}`,
            emittedAt: new Date().toISOString(),
          });
        }
      };

      if (nativeSpeechActivity || hasSpeechActivity) {
        await stopStep('speech', stopSpeechDispatchRuntime);
      }
      await stopStep('translate', stopTranslateWorkerRuntime);
      if (outboundBound) {
        await stopStep('outbound', () => stopAudioRouteRuntime('outbound'));
      }
      if (inboundBound) {
        await stopStep('inbound', () => stopAudioRouteRuntime('inbound'));
      }
    });
  };

  const startWatchFallback = async (options: SceneLaunchOptions, fallback: 'subtitles-only' | 'aec', originalError?: unknown) => {
    const originalErrorMessage = originalError instanceof Error ? originalError.message : originalError == null ? '' : String(originalError);
    appendFrontendDiagnosticsLog('runtime', 'warning', `[WatchFallback] fallback strategy: ${fallback}`, stringifyRedacted({
      originalError: originalErrorMessage,
      bridge: runtimeSnapshot.bridge,
      config: options.configDraft,
      audio: options.audioSnapshot,
    }));
    const subtitlesOnly = fallback === 'subtitles-only';
    const devicesPatch = {
      feedbackLoopPrevention: subtitlesOnly ? ('none' as const) : ('echo-cancel' as const),
      outputSpeechEnabled: !subtitlesOnly,
      virtualMicOutputEnabled: false,
      aecEnabled: !subtitlesOnly,
      routeMode: 'watch' as const,
      status: 'warning' as const,
    };
    const speechPatch = {
      enabled: !subtitlesOnly,
      outputTarget: 'speaker' as const,
      localPlaybackEnabled: !subtitlesOnly,
      virtualMicOutputEnabled: false,
      status: 'warning' as const,
    };
    controller.updateDeviceDraft(devicesPatch);
    controller.updateSpeechDraft(speechPatch);
    const fallbackPlan = buildWatchFallbackPlan({
      ...options,
      configDraft: {
        ...options.configDraft,
        devices: { ...options.configDraft.devices, ...devicesPatch },
        speech: { ...options.configDraft.speech, ...speechPatch },
      },
      speechPatch,
    });
    let snapshot = options.audioSnapshot;
    let fallbackStage: SceneLaunchStage | null = null;
    try {
      await executeSceneLaunchPlan(fallbackPlan, {
      ensureBridgeReady: async () => undefined,
      preconnectOmni: async () => undefined,
      cancelPreconnectOmni: async () => undefined,
      onPreconnectWarning: () => undefined,
      onStageStart: (stage) => { fallbackStage = stage; },
      executeStage: async (stage) => {
        if (stage === 'inbound-route') snapshot = await startAudioRouteRuntime('inbound', fallbackPlan.config);
        else if (stage === 'translate-worker') snapshot = await startTranslateWorkerRuntime(fallbackPlan.config);
        else if (stage === 'speech-dispatch') snapshot = await startSpeechDispatchRuntime(fallbackPlan.config);
        else if (stage === 'subtitle-overlay') setRuntimeSnapshot(await showSubtitleOverlayWindow());
        if (stage !== 'subtitle-overlay') controller.setAudioSnapshot(snapshot);
      },
      compensateStage: async (stage) => {
        if (stage === 'inbound-route') snapshot = await stopAudioRouteRuntime('inbound');
        else if (stage === 'translate-worker') snapshot = await stopTranslateWorkerRuntime();
        else if (stage === 'speech-dispatch') snapshot = await stopSpeechDispatchRuntime();
        controller.setAudioSnapshot(snapshot);
      },
      });
    } catch (error) {
      if (error && typeof error === 'object') {
        Object.assign(error, { fallbackStage });
      }
      throw error;
    }
    controller.pushNotification({
      id: `watch-fallback-${fallback}-${Date.now()}`,
      level: 'warning',
      source: 'session',
      message: `${subtitlesOnly ? '已降级为仅字幕模式' : '已降级为回声消除模式'}${originalErrorMessage ? `（原始错误：${originalErrorMessage}）` : ''}`,
      emittedAt: new Date().toISOString(),
    });
  };

  const launchScene = async (options: SceneLaunchOptions) => {
    const { mode } = options;
    if ([options.audioSnapshot.inbound.captureState, options.audioSnapshot.outbound.captureState].includes('stopping')) {
      controller.pushNotification({ id: `scene-launch-stopping-${Date.now()}`, level: 'warning', source: 'session', message: '正在停止上一条链路，请稍后再启动新场景。', emittedAt: new Date().toISOString() });
      return;
    }
    const plan = buildSceneLaunchPlan(options);
    const nextConfig = plan.config;
    const launchTimeoutMs = sceneLaunchTimeoutMs(mode, options.isOmniModel);
    const launchTimeoutMessage = controller.sceneLaunchTimeoutMessage(launchTimeoutMs / 1_000);
    let launchStage: SceneLaunchStage | null = null;
    let preconnectWarning: string | null = null;
    try {
      await controller.runBusyAction(mode === 'watch' ? 'watch-start' : 'conversation-start', async () => {
        const launchStartedAt = Date.now();
        let snapshot = options.audioSnapshot;
        let launchTimedOut = false;
        const launchAbortController = new AbortController();
        const launchOperation = executeSceneLaunchPlan(plan, {
          abortSignal: launchAbortController.signal,
          ensureBridgeReady: async () => {
            await ensureBridgeReady(mode, nextConfig);
            controller.updateDeviceDraft({
              routeMode: mode,
              status: 'ready',
              ...(mode !== 'watch' ? {
                feedbackLoopPrevention: 'echo-cancel' as const,
                aecEnabled: true,
                outputSpeechEnabled: true,
                virtualMicOutputEnabled: false,
              } : {}),
            });
            controller.updateSpeechDraft(options.speechPatch);
            controller.updateDiagnosticsReady(mode);
          },
          preconnectOmni: async () => {
            controller.setAudioSnapshot(await preconnectOmniRealtimeRuntime(nextConfig));
          },
          cancelPreconnectOmni: async () => {
            controller.setAudioSnapshot(await cancelOmniPreconnectRuntime());
          },
          onPreconnectWarning: (error) => {
            preconnectWarning = `Omni 预连接失败，已改走普通启动路径：${error instanceof Error ? error.message : String(error)}`;
            appendFrontendDiagnosticsLog('runtime', 'warning', `[WatchPreconnect] ${preconnectWarning}`);
          },
          executeStage: async (stage) => {
            if (stage === 'inbound-route' && mode === 'watch') {
              snapshot = await startAudioRouteRuntime('inbound', nextConfig);
              controller.setAudioSnapshot(snapshot);
              snapshot = await waitForWatchRouteReadyRuntime(launchTimeoutMs, launchAbortController.signal);
              controller.setAudioSnapshot(snapshot);
              appendFrontendDiagnosticsLog('runtime', 'info', '[WatchLaunch] native route ready', stringifyRedacted({
                captureState: snapshot.inbound.captureState,
                streamBound: snapshot.inbound.streamBound,
                routeId: snapshot.inbound.routeId,
              }));
            }
            else if (stage === 'inbound-route') snapshot = await startAudioRouteRuntime('inbound', nextConfig);
            else if (stage === 'outbound-route') snapshot = await startAudioRouteRuntime('outbound', nextConfig);
            else if (stage === 'translate-worker') snapshot = await startTranslateWorkerRuntime(nextConfig);
            else if (stage === 'speech-dispatch') snapshot = await startSpeechDispatchRuntime(nextConfig);
            else setRuntimeSnapshot(await showSubtitleOverlayWindow());
            if (stage !== 'subtitle-overlay') controller.setAudioSnapshot(snapshot);
            if (launchTimedOut) {
              if (stage === 'inbound-route') snapshot = await stopAudioRouteRuntime('inbound');
              else if (stage === 'outbound-route') snapshot = await stopAudioRouteRuntime('outbound');
              else if (stage === 'translate-worker') snapshot = await stopTranslateWorkerRuntime();
              else if (stage === 'speech-dispatch') snapshot = await stopSpeechDispatchRuntime();
              if (stage !== 'subtitle-overlay') controller.setAudioSnapshot(snapshot);
              throw sceneLaunchTimeoutError(launchTimeoutMessage);
            }
          },
          compensateStage: async (stage) => {
            if (stage === 'inbound-route') snapshot = await stopAudioRouteRuntime('inbound');
            else if (stage === 'outbound-route') snapshot = await stopAudioRouteRuntime('outbound');
            else if (stage === 'translate-worker') snapshot = await stopTranslateWorkerRuntime();
            else if (stage === 'speech-dispatch') snapshot = await stopSpeechDispatchRuntime();
            controller.setAudioSnapshot(snapshot);
            /* Legacy overlay-specific notification removed; failure is reported after transactional rollback.
            controller.pushNotification({ id: `scene-overlay-${mode}-${Date.now()}`, level: 'error', source: 'session', message: `字幕浮窗打开失败：${error instanceof Error ? error.message : String(error)}`, emittedAt: new Date().toISOString() });
            */
          },
          onStageStart: (stage) => {
            launchStage = stage;
            appendFrontendDiagnosticsLog('runtime', 'info', '[SceneLaunch] stage start', stringifyRedacted({
              mode,
              stage,
              elapsedMs: Date.now() - launchStartedAt,
            }));
          },
        });
        await withSceneLaunchTimeout(launchOperation, launchTimeoutMs, launchTimeoutMessage, async () => {
          launchTimedOut = true;
          appendFrontendDiagnosticsLog('runtime', 'warning', '[SceneLaunch] timeout', stringifyRedacted({
            mode,
            stage: launchStage,
            elapsedMs: Date.now() - launchStartedAt,
            timeoutMs: launchTimeoutMs,
          }));
          launchAbortController.abort(sceneLaunchTimeoutError(launchTimeoutMessage));
          await Promise.allSettled([
            cancelOmniPreconnectRuntime(),
            stopSpeechDispatchRuntime(),
            stopTranslateWorkerRuntime(),
            stopAudioRouteRuntime('outbound'),
            stopAudioRouteRuntime('inbound'),
          ]);
          try {
            controller.setAudioSnapshot(await getAudioRuntimeSnapshotRuntime());
          } catch {
            // The timeout error remains the user-facing result.
          }
        });
        appendFrontendDiagnosticsLog('runtime', 'info', '[SceneLaunch] ready', stringifyRedacted({
          mode,
          elapsedMs: Date.now() - launchStartedAt,
          stages: plan.stages,
        }));
        if (preconnectWarning) controller.pushNotification({ id: `watch-preconnect-${Date.now()}`, level: 'warning', source: 'session', message: preconnectWarning, emittedAt: new Date().toISOString() });
      });
    } catch (error) {
      const launchError = error instanceof SceneLaunchError ? error.cause : error;
      if (error instanceof SceneLaunchError) {
        appendFrontendDiagnosticsLog('runtime', error.outcome.status === 'rollback-failed' ? 'error' : 'warning',
          `[SceneLaunch] status=${error.outcome.status} completed=${error.outcome.completedStages.join(',')} rolledBack=${error.outcome.rolledBackStages.join(',')} rollbackFailures=${error.outcome.rollbackFailures.length}`);
      }
      if (mode === 'watch' && watchModeNeedsBridge(nextConfig) && isBridgeStartupError(launchError)) {
        const fallback = controller.confirmWatchFallback() ? 'subtitles-only' : 'aec';
        try {
          await startWatchFallback(options, fallback, launchError);
        } catch (fallbackError) {
          let nativeSnapshot: AudioRuntimeSnapshot | null = null;
          try {
            nativeSnapshot = await getAudioRuntimeSnapshotRuntime();
            controller.setAudioSnapshot(nativeSnapshot);
          } catch {
            // The combined error below still records that the native snapshot was unavailable.
          }
          const fallbackCause = fallbackError instanceof SceneLaunchError ? fallbackError.cause : fallbackError;
          appendFrontendDiagnosticsLog('runtime', 'error', '[WatchFallback] fallback failed', stringifyRedacted({
            originalError: launchError instanceof Error ? launchError.message : String(launchError),
            fallback,
            fallbackStage: fallbackError && typeof fallbackError === 'object' && 'fallbackStage' in fallbackError
              ? fallbackError.fallbackStage
              : 'unknown',
            fallbackError: fallbackCause instanceof Error ? fallbackCause.message : String(fallbackCause),
            nativeSnapshot,
          }));
          controller.pushNotification({
            id: `watch-fallback-failed-${Date.now()}`,
            level: 'error',
            source: 'session',
            message: `看片模式启动失败，${fallback} 降级也未能完成：${fallbackCause instanceof Error ? fallbackCause.message : String(fallbackCause)}`,
            emittedAt: new Date().toISOString(),
          });
        }
        return;
      }
      if (launchStage === 'subtitle-overlay') {
        controller.pushNotification({
          id: `scene-overlay-${mode}-${Date.now()}`,
          level: 'error',
          source: 'session',
          message: `字幕浮窗打开失败：${launchError instanceof Error ? launchError.message : String(launchError)}`,
          emittedAt: new Date().toISOString(),
        });
      }
      controller.pushNotification({ id: `scene-launch-${mode}-${Date.now()}`, level: 'error', source: 'session', message: controller.sceneLaunchFailureMessage(mode, launchStage, launchError), emittedAt: new Date().toISOString() });
    }
  };

  return { ensureBridgeReady, launchScene, stopAll };
}
