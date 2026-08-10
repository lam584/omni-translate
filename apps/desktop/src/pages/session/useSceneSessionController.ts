import i18n from '../../i18n/config';
import type { AppConfigDraft } from '../../schema/config';
import type { RuntimeSnapshot } from '../../schema/runtime-core';
import type { RuntimeNotification } from '../../schema/runtime-core';
import type { AudioRuntimeSnapshot } from '../../schema/audio-runtime';
import {
  cancelOmniPreconnectRuntime,
  getAudioRuntimeSnapshotRuntime,
  preconnectOmniRealtimeRuntime,
  showSubtitleOverlayWindow,
  toggleSubtitleOverlayWindow,
  startAudioRouteRuntime,
  waitForWatchRouteReadyRuntime,
  startSpeechDispatchRuntime,
  startTranslateWorkerRuntime,
  stopAudioRouteRuntime,
  stopSpeechDispatchRuntime,
  stopTranslateWorkerRuntime,
} from '../../runtime/audio-runtime';
import {
  installDriverRuntime,
  refreshBridgeRuntime,
  repairDriverRuntime,
  startBridgeServiceRuntime,
} from '../../runtime/bridge-runtime';
import { appendFrontendDiagnosticsLog, getRecentDiagnosticsLogsRuntime } from '../../runtime/diagnostics-runtime';
import type { SceneMode } from '../../utils/scene-readiness';
import type { ResolvedRealtimeProfile } from '../../utils/realtime-profile';
import { watchModeNeedsBridge } from '../../utils/scene-readiness';
import { stringifyRedacted } from '../../utils/redact-sensitive-data';
import { extractSessionErrorCode } from '../../utils/session-error-presentation';
import { resolveAecCapability } from '../../utils/aec-capability';
import { bridgeCaptureRouteMatches, bridgeProcessIsRunning } from '../../utils/bridge-capture-route';
import {
  isProcessLoopbackReady,
  isProcessLoopbackSelectable,
  resolveProcessLoopbackCapability,
} from '../../utils/process-loopback-capability';
import { buildSceneLaunchPlan, buildWatchFallbackPlan, type SceneLaunchStage } from './sceneLaunchPlan';
import { executeSceneLaunchPlan, SceneLaunchError } from './sceneLaunchExecutor';
import { sceneLaunchTimeoutMs } from './sceneLaunchTimeout';
import { describeSceneLaunchAttribution } from './sceneLaunchAttribution';

type SceneSessionControllerOptions = {
  runtimeSnapshot: RuntimeSnapshot;
  setRuntimeSnapshot: (snapshot: RuntimeSnapshot) => void;
  setAudioSnapshot: (snapshot: AudioRuntimeSnapshot) => void;
  updateDeviceDraft: (patch: Partial<AppConfigDraft['devices']>) => void;
  updateSpeechDraft: (patch: Partial<AppConfigDraft['speech']>) => void;
  updateDiagnosticsReady: (mode: SceneMode) => void;
  pushNotification: (notification: RuntimeNotification) => void;
  runBusyAction: BusyActionRunner;
  confirmWatchFallback: () => Promise<boolean>;
  sceneLaunchFailureMessage: (mode: SceneMode, stage: string | null, error: unknown) => string;
  sceneLaunchTimeoutMessage: (seconds: number) => string;
};

type BusyActionRunner = (action: 'watch-start' | 'conversation-start' | 'stop', task: () => Promise<void>) => Promise<void>;

type SceneLaunchOptions = {
  launchAttemptId: string;
  mode: SceneMode;
  configDraft: AppConfigDraft;
  audioSnapshot: AudioRuntimeSnapshot;
  overlayVisible: boolean;
  realtimeProfile: Pick<ResolvedRealtimeProfile, 'nativeTranslation' | 'speechDispatchPolicy'>;
  speechPatch: Partial<AppConfigDraft['speech']> & { enabled: boolean };
  secondarySubtitleTranslationEnabled: boolean;
};

function sceneLaunchTimeoutError(message: string) {
  return new Error(message);
}

function tagSceneLaunchError(
  message: string,
  code: 'session.launch-precheck-failed' | 'session.launch-stage-failed' | 'session.launch-timeout' | 'bridge.virtual-mic-output-unavailable',
) {
  return `${message} | code: ${code} | recommended: restart-session`;
}

async function withSceneLaunchTimeout<T>(operation: Promise<T>, timeoutMs: number, timeoutMessage: string, onTimeout: () => Promise<void>): Promise<T> {
  let rejectTimeout!: (reason: Error) => void;
  const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const timerId = setTimeout(() => {
    void onTimeout().catch((error) => {
      appendFrontendDiagnosticsLog('runtime', 'warning', `[SceneLaunch] timeout cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    rejectTimeout(sceneLaunchTimeoutError(timeoutMessage));
  }, timeoutMs);
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timerId);
  }
}

function isBridgeStartupError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  // Session-domain errors carry an explicit `| code:` marker; they must never
  // be misread as bridge failures by the keyword fallback below.
  if (extractSessionErrorCode(message) !== null) {
    return false;
  }
  const lower = message.toLowerCase();
  return ['bridge', 'driver', 'source pipe', 'virtual', 'sysvad', 'package', 'wasapi'].some((token) => lower.includes(token));
}

function assertBridgeCaptureRoute(
  snapshot: RuntimeSnapshot,
  feedbackMode: AppConfigDraft['devices']['feedbackLoopPrevention'],
) {
  if (!bridgeProcessIsRunning(snapshot.bridge) || !bridgeCaptureRouteMatches(snapshot.bridge, feedbackMode)) {
    throw new Error(
      `Bridge capture backend did not converge: requested=${feedbackMode} `
      + `actual=${snapshot.bridge.sourceCaptureMode}/${snapshot.bridge.captureBackend} `
      + `process=${snapshot.bridge.processStatus}/${snapshot.bridge.bridgeState}`,
    );
  }
}

function assertProcessExclusionReady(snapshot: RuntimeSnapshot) {
  assertBridgeCaptureRoute(snapshot, 'process-exclusion');
  const capability = resolveProcessLoopbackCapability(snapshot.bridge);
  if (!isProcessLoopbackReady(capability)) {
    throw new Error(capability.failureDetail ?? `process-loopback status=${capability.status}`);
  }
}

/**
 * Turns a watch launch failure into an attributable Error whose message names
 * the terminal outcome (command rejected / accepted-but-not-ready / capture
 * error) with the last native snapshot and route markers. Best-effort reads of
 * the native snapshot and diagnostics log degrade to null/[] on failure.
 */
async function describeWatchLaunchFailure(
  stage: SceneLaunchStage | null,
  error: unknown,
  commandAccepted: boolean,
): Promise<Error> {
  let snapshot: AudioRuntimeSnapshot | null = null;
  try {
    snapshot = await getAudioRuntimeSnapshotRuntime();
  } catch (snapshotError) {
    appendFrontendDiagnosticsLog('runtime', 'warning', `[SceneLaunch] attribution snapshot read failed: ${snapshotError instanceof Error ? snapshotError.message : String(snapshotError)}`);
  }
  const recentLogs = await getRecentDiagnosticsLogsRuntime();
  const attribution = describeSceneLaunchAttribution({ stage, error, snapshot, recentLogs, commandAccepted });
  appendFrontendDiagnosticsLog('runtime', 'warning', '[SceneLaunch] attribution', stringifyRedacted({
    stage,
    outcome: attribution.outcome,
    commandAccepted,
    captureState: snapshot?.inbound.captureState ?? null,
    streamBound: snapshot?.inbound.streamBound ?? null,
    preBufferState: snapshot?.inbound.preBufferState ?? null,
  }));
  return new Error(attribution.message);
}

/** Coordinates the Bridge readiness sequence used before scene startup. */
export function useSceneSessionController(controller: SceneSessionControllerOptions) {
  const { runtimeSnapshot, setRuntimeSnapshot } = controller;
  // A launch may reconfigure Bridge and then enter the Watch fallback inside
  // the same render closure. Keep that successful native snapshot locally as
  // well as publishing it to the store; otherwise fallback would reason from
  // the pre-launch snapshot and could leave the just-started backend alive.
  let latestBridgeRuntime = runtimeSnapshot;
  const publishBridgeRuntime = (snapshot: RuntimeSnapshot) => {
    latestBridgeRuntime = snapshot;
    setRuntimeSnapshot(snapshot);
  };
  const ensureBridgeReady = async (mode: SceneMode, nextConfig: AppConfigDraft): Promise<RuntimeSnapshot> => {
    const currentRuntime = latestBridgeRuntime;
    const feedbackMode = nextConfig.devices.feedbackLoopPrevention;
    const bridgeProcessAlive = currentRuntime.bridge.processStatus === 'running';
    const runningRouteNeedsNeutralization = mode === 'watch'
      && bridgeProcessAlive
      && !bridgeCaptureRouteMatches(currentRuntime.bridge, feedbackMode);
    if (!watchModeNeedsBridge(nextConfig) && !runningRouteNeedsNeutralization) {
      return currentRuntime;
    }

    if (feedbackMode === 'process-exclusion') {
      let latestRuntime = currentRuntime;
      if (!bridgeProcessIsRunning(currentRuntime.bridge)
        || !bridgeCaptureRouteMatches(currentRuntime.bridge, feedbackMode)) {
        latestRuntime = await startBridgeServiceRuntime(nextConfig);
        publishBridgeRuntime(latestRuntime);
      } else if (!isProcessLoopbackReady(resolveProcessLoopbackCapability(currentRuntime.bridge))) {
        latestRuntime = await refreshBridgeRuntime();
        publishBridgeRuntime(latestRuntime);
        if (!bridgeProcessIsRunning(latestRuntime.bridge)
          || !bridgeCaptureRouteMatches(latestRuntime.bridge, feedbackMode)) {
          latestRuntime = await startBridgeServiceRuntime(nextConfig);
          publishBridgeRuntime(latestRuntime);
        }
      }
      assertProcessExclusionReady(latestRuntime);
      return latestRuntime;
    }

    // Keep the Watch path free of synchronous driver install/repair, but make
    // launch itself authoritative: bootstrap may still be pending, and a user
    // can change modes after bootstrap. A stopped/mismatched virtual-driver
    // route is initialized here; AEC/none re-initializes an old running Bridge
    // to the neutral `none` backend so stale source/output cannot survive.
    if (mode === 'watch') {
      if (feedbackMode === 'virtual-driver') {
        if (!bridgeProcessIsRunning(currentRuntime.bridge)
          || !bridgeCaptureRouteMatches(currentRuntime.bridge, feedbackMode)) {
          const started = await startBridgeServiceRuntime(nextConfig);
          publishBridgeRuntime(started);
          assertBridgeCaptureRoute(started, feedbackMode);
          return started;
        }
        return currentRuntime;
      }
      if (runningRouteNeedsNeutralization) {
        const started = await startBridgeServiceRuntime(nextConfig);
        publishBridgeRuntime(started);
        assertBridgeCaptureRoute(started, feedbackMode);
        return started;
      }
      return currentRuntime;
    }

    // Bridge lifecycle IPC goes through the bridge-runtime wrappers so every
    // step carries the shared timeout gate and lifecycle trace: a hung native
    // command surfaces as an attributable timeout error instead of leaving the
    // launch path suspended forever.
    let latestRuntime: RuntimeSnapshot;
    try {
      latestRuntime = await refreshBridgeRuntime();
      publishBridgeRuntime(latestRuntime);
    } catch (refreshError) {
      appendFrontendDiagnosticsLog(
        'runtime',
        'warning',
        `[BridgeReady] refresh failed, proceeding with cached snapshot: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`,
      );
      latestRuntime = currentRuntime;
    }

    if (latestRuntime.bridge.driverHealth === 'not-installed') {
      latestRuntime = await installDriverRuntime(nextConfig);
      publishBridgeRuntime(latestRuntime);
    }
    if (latestRuntime.bridge.driverHealth !== 'running') {
      const repairAction = latestRuntime.bridge.recommendedAction === 'rollback-driver'
        ? 'rollback-driver' as const
        : latestRuntime.bridge.recommendedAction === 'restart-bridge'
          ? 'restart-bridge' as const
          : 'reinstall-driver' as const;
      latestRuntime = await repairDriverRuntime(repairAction, nextConfig);
      publishBridgeRuntime(latestRuntime);
    }
    if (!bridgeProcessIsRunning(latestRuntime.bridge)
      || !bridgeCaptureRouteMatches(latestRuntime.bridge, feedbackMode)) {
      const started = await startBridgeServiceRuntime(nextConfig);
      publishBridgeRuntime(started);
      assertBridgeCaptureRoute(started, feedbackMode);
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
      // A route needs a native stop not only when its stream is bound, but for
      // the whole accepted-but-converging window (armed/buffering/…): native
      // fast-watch acknowledges immediately and binds the stream later, so a
      // streamBound-only gate would leave capture/translate running after the
      // user pressed stop. The native stop command is serialized behind the
      // pipeline lock and is idempotent for routes that never finished binding.
      const routeNeedsStop = (route: AudioRuntimeSnapshot['inbound']) =>
        route.streamBound || !['idle', 'stopping'].includes(route.captureState);
      const inboundBound = routeNeedsStop(nativeSnapshot.inbound);
      const outboundBound = routeNeedsStop(nativeSnapshot.outbound);
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
            message: i18n.t('session.stopStepFailed', { label, detail }),
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

  const startWatchFallback = async (options: SceneLaunchOptions, fallback: 'subtitles-only' | 'aec', originalError: unknown) => {
    const originalErrorMessage = originalError instanceof Error ? originalError.message : String(originalError);
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
      ensureBridgeReady: async () => {
        // Fallback is a real mode switch. Converge a running driver/process
        // backend to `none` before binding the new endpoint-loopback route so
        // no old source generation or translation queue survives.
        await ensureBridgeReady('watch', fallbackPlan.config);
        if (!subtitlesOnly) {
          const capability = resolveAecCapability(options.audioSnapshot);
          if (!capability.ready) {
            const detail = capability.failureDetail ?? capability.status;
            appendFrontendDiagnosticsLog('runtime', 'warning', '[WatchFallback] WebRTC AEC3 unavailable', stringifyRedacted({
              backend: capability.backend,
              status: capability.status,
              detail,
            }));
            throw new Error(tagSceneLaunchError(
              i18n.t('session.aecUnavailable', { detail }),
              'session.launch-precheck-failed',
            ));
          }
        }
      },
      preconnectOmni: async () => undefined,
      cancelPreconnectOmni: async () => undefined,
      onPreconnectWarning: String,
      onStageStart: (stage) => { fallbackStage = stage; },
      executeStage: async (stage) => {
        if (stage === 'inbound-route') snapshot = await startAudioRouteRuntime('inbound', fallbackPlan.config);
        else if (stage === 'translate-worker') snapshot = await startTranslateWorkerRuntime(fallbackPlan.config);
        else if (stage === 'speech-dispatch') snapshot = await startSpeechDispatchRuntime(fallbackPlan.config);
        else if (stage === 'subtitle-overlay') setRuntimeSnapshot(await showSubtitleOverlayWindow());
        if (stage !== 'subtitle-overlay') controller.setAudioSnapshot(snapshot);
      },
      compensateStage: async (stage) => {
        if (stage === 'subtitle-overlay') {
          setRuntimeSnapshot(await toggleSubtitleOverlayWindow());
          return;
        }
        if (stage === 'inbound-route') snapshot = await stopAudioRouteRuntime('inbound');
        else if (stage === 'translate-worker') snapshot = await stopTranslateWorkerRuntime();
        else snapshot = await stopSpeechDispatchRuntime();
        controller.setAudioSnapshot(snapshot);
      },
      });
    } catch (error) {
      Object.assign(error as object, { fallbackStage });
      throw error;
    }
    controller.pushNotification({
      id: `watch-fallback-${fallback}-${Date.now()}`,
      level: 'warning',
      source: 'session',
      message: subtitlesOnly ? i18n.t('session.fallbackSubtitlesOnlyMode', { error: originalErrorMessage }) : i18n.t('session.fallbackAecMode', { error: originalErrorMessage }),
      emittedAt: new Date().toISOString(),
    });
  };

  const launchScene = async (options: SceneLaunchOptions) => {
    const { launchAttemptId, mode } = options;
    if ([options.audioSnapshot.inbound.captureState, options.audioSnapshot.outbound.captureState].includes('stopping')) {
      controller.pushNotification({ id: `scene-launch-stopping-${Date.now()}`, level: 'warning', source: 'session', message: tagSceneLaunchError(i18n.t('session.stoppingPreviousRoute'), 'session.launch-precheck-failed'), emittedAt: new Date().toISOString() });
      return;
    }
    const plan = buildSceneLaunchPlan(options);
    const nextConfig = plan.config;
    if (
      mode === 'watch'
      && nextConfig.devices.feedbackLoopPrevention === 'none'
      && (nextConfig.devices.outputSpeechEnabled || options.speechPatch.enabled)
    ) {
      appendFrontendDiagnosticsLog('runtime', 'warning', '[SceneLaunch] translated speech requires a feedback route');
      controller.pushNotification({
        id: `scene-launch-feedback-route-required-${Date.now()}`,
        level: 'error',
        source: 'session',
        message: tagSceneLaunchError(i18n.t('session.feedbackRouteRequired'), 'session.launch-precheck-failed'),
        emittedAt: new Date().toISOString(),
      });
      return;
    }
    if (
      mode !== 'watch'
      && ['virtual-driver', 'process-exclusion'].includes(options.configDraft.devices.feedbackLoopPrevention)
    ) {
      appendFrontendDiagnosticsLog(
        'runtime',
        'error',
        '[SceneLaunch] outbound virtual microphone backend unavailable',
        stringifyRedacted({
          feedbackLoopPrevention: options.configDraft.devices.feedbackLoopPrevention,
          errorCode: 'bridge.virtual-mic-output-unavailable',
        }),
      );
      controller.pushNotification({
        id: `scene-launch-virtual-mic-output-unavailable-${Date.now()}`,
        level: 'error',
        source: 'session',
        message: tagSceneLaunchError(
          i18n.t('audioRouting.unsupportedVirtualMicSpeech'),
          'bridge.virtual-mic-output-unavailable',
        ),
        emittedAt: new Date().toISOString(),
      });
      return;
    }
    if (nextConfig.devices.feedbackLoopPrevention === 'echo-cancel') {
      const capability = resolveAecCapability(options.audioSnapshot);
      if (!capability.ready) {
        const detail = capability.failureDetail ?? capability.status;
        appendFrontendDiagnosticsLog('runtime', 'warning', '[SceneLaunch] WebRTC AEC3 unavailable', stringifyRedacted({
          backend: capability.backend,
          status: capability.status,
          detail,
        }));
        controller.pushNotification({
          id: `scene-launch-aec-unavailable-${Date.now()}`,
          level: 'error',
          source: 'session',
          message: tagSceneLaunchError(i18n.t('session.aecUnavailable', { detail }), 'session.launch-precheck-failed'),
          emittedAt: new Date().toISOString(),
        });
        return;
      }
    }
    if (mode === 'watch' && nextConfig.devices.feedbackLoopPrevention === 'process-exclusion') {
      const capability = resolveProcessLoopbackCapability(runtimeSnapshot.bridge);
      if (!isProcessLoopbackSelectable(capability)) {
        const detail = capability.failureDetail
          ?? (capability.status === 'unsupported'
            ? `Windows build ${capability.windowsBuildNumber ?? 'unknown'} < ${capability.minimumWindowsBuild}`
            : capability.status);
        appendFrontendDiagnosticsLog('runtime', 'warning', '[SceneLaunch] process exclusion unavailable', stringifyRedacted({
          status: capability.status,
          supported: capability.supported,
          windowsBuildNumber: capability.windowsBuildNumber,
          minimumWindowsBuild: capability.minimumWindowsBuild,
          detail,
        }));
        controller.pushNotification({
          id: `scene-launch-process-exclusion-${Date.now()}`,
          level: 'error',
          source: 'session',
          message: tagSceneLaunchError(i18n.t('session.processExclusionUnavailable', { detail }), 'session.launch-precheck-failed'),
          emittedAt: new Date().toISOString(),
        });
        return;
      }
    }
    const launchTimeoutMs = sceneLaunchTimeoutMs(mode, nextConfig.devices.feedbackLoopPrevention);
    const launchTimeoutMessage = controller.sceneLaunchTimeoutMessage(launchTimeoutMs / 1_000);
    let launchStage: SceneLaunchStage | null = null;
    let preconnectWarning: string | null = null;
    // Whether the native start_audio_route command acknowledged the watch route.
    // Distinguishes "command rejected" from "accepted but capture not ready".
    let routeCommandAccepted = false;
    try {
      await controller.runBusyAction(mode === 'watch' ? 'watch-start' : 'conversation-start', async () => {
        const launchStartedAt = Date.now();
        let snapshot = options.audioSnapshot;
        let launchTimedOut = false;
        // Whether this launch opened the subtitle overlay. The outer-timeout
        // cleanup (and a late-resolving overlay open) must hide exactly what
        // the launch opened — the executor's rollback cannot reach a stage
        // that completed before the outer deadline fired.
        let overlayOpenedByLaunch = false;
        // Sync non-route scene settings before the plan executes. The selected
        // feedback route itself is preserved exactly; legacy `none` is never
        // rewritten to another backend behind the user's back.
        controller.updateDeviceDraft({
          routeMode: mode,
          status: 'ready',
          feedbackLoopPrevention: nextConfig.devices.feedbackLoopPrevention,
          aecEnabled: nextConfig.devices.aecEnabled,
          outputSpeechEnabled: nextConfig.devices.outputSpeechEnabled,
          virtualMicOutputEnabled: nextConfig.devices.virtualMicOutputEnabled,
        });
        controller.updateSpeechDraft(options.speechPatch);
        controller.updateDiagnosticsReady(mode);
        const launchAbortController = new AbortController();
        const launchOperation = executeSceneLaunchPlan(plan, {
          abortSignal: launchAbortController.signal,
          ensureBridgeReady: async () => {
            await ensureBridgeReady(mode, nextConfig);
          },
          preconnectOmni: async () => {
            controller.setAudioSnapshot(await preconnectOmniRealtimeRuntime(nextConfig));
          },
          cancelPreconnectOmni: async () => {
            controller.setAudioSnapshot(await cancelOmniPreconnectRuntime());
          },
          onPreconnectWarning: (error) => {
            preconnectWarning = i18n.t('session.preconnectFailedFallback', { error: error instanceof Error ? error.message : String(error) });
            appendFrontendDiagnosticsLog('runtime', 'warning', `[WatchPreconnect] ${preconnectWarning}`);
          },
          executeStage: async (stage) => {
            if (stage === 'inbound-route' && mode === 'watch') {
              snapshot = await startAudioRouteRuntime('inbound', nextConfig);
              routeCommandAccepted = true;
              controller.setAudioSnapshot(snapshot);
              snapshot = await waitForWatchRouteReadyRuntime(launchTimeoutMs, launchAbortController.signal);
              controller.setAudioSnapshot(snapshot);
              appendFrontendDiagnosticsLog('runtime', 'info', '[WatchLaunch] native route ready', stringifyRedacted({
                launchAttemptId,
                captureState: snapshot.inbound.captureState,
                streamBound: snapshot.inbound.streamBound,
                routeId: snapshot.inbound.routeId,
              }));
            }
            else if (stage === 'inbound-route') snapshot = await startAudioRouteRuntime('inbound', nextConfig);
            else if (stage === 'outbound-route') snapshot = await startAudioRouteRuntime('outbound', nextConfig);
            else if (stage === 'translate-worker') snapshot = await startTranslateWorkerRuntime(nextConfig);
            else if (stage === 'speech-dispatch') snapshot = await startSpeechDispatchRuntime(nextConfig);
            else {
              const overlayRuntime = await showSubtitleOverlayWindow();
              if (!launchTimedOut) {
                setRuntimeSnapshot(overlayRuntime);
                overlayOpenedByLaunch = true;
              }
            }
            // After the outer timeout fired, a late start result is stale: the
            // cleanup already published the stopped state, so publishing the
            // started snapshot here would resurrect a torn-down session in the UI.
            if (stage !== 'subtitle-overlay' && !launchTimedOut) controller.setAudioSnapshot(snapshot);
            if (launchTimedOut) {
              if (stage === 'inbound-route') snapshot = await stopAudioRouteRuntime('inbound');
              else if (stage === 'outbound-route') snapshot = await stopAudioRouteRuntime('outbound');
              else if (stage === 'translate-worker') snapshot = await stopTranslateWorkerRuntime();
              else if (stage === 'speech-dispatch') snapshot = await stopSpeechDispatchRuntime();
              else setRuntimeSnapshot(await toggleSubtitleOverlayWindow());
              if (stage !== 'subtitle-overlay') controller.setAudioSnapshot(snapshot);
              throw sceneLaunchTimeoutError(launchTimeoutMessage);
            }
          },
          compensateStage: async (stage) => {
            if (stage === 'subtitle-overlay') {
              setRuntimeSnapshot(await toggleSubtitleOverlayWindow());
              overlayOpenedByLaunch = false;
              return;
            }
            if (stage === 'inbound-route') snapshot = await stopAudioRouteRuntime('inbound');
            else if (stage === 'outbound-route') snapshot = await stopAudioRouteRuntime('outbound');
            else if (stage === 'translate-worker') snapshot = await stopTranslateWorkerRuntime();
            else snapshot = await stopSpeechDispatchRuntime();
            controller.setAudioSnapshot(snapshot);
          },
          onStageStart: (stage) => {
            launchStage = stage;
            appendFrontendDiagnosticsLog('runtime', 'info', '[SceneLaunch] stage start', stringifyRedacted({
              launchAttemptId,
              mode,
              stage,
              elapsedMs: Date.now() - launchStartedAt,
            }));
          },
        });
        if (mode === 'watch') {
          // Watch capture is fire-and-converge and already self-bounded: the
          // native `start_audio_route` returns on acknowledgement,
          // `waitForWatchRouteReadyRuntime` polls within its own budget and
          // resolves once the stream binds (or as "accepted, still converging"
          // when the budget elapses without a native error), and any remaining
          // watch stages carry their own native command timeouts. A destructive
          // outer deadline here would `abort` and `stop_audio_route` a route that
          // is still legitimately converging — which is exactly what made
          // clicking watch mode appear to do nothing (the launch tore down a
          // route that was ~1.4s from ready and swallowed the outcome). Let the
          // native push events (stream bound, or `lastError` rendered by the
          // session screen) drive the UI instead. This does not lengthen any
          // timeout; it removes a premature rollback.
          await launchOperation;
        } else {
          await withSceneLaunchTimeout(launchOperation, launchTimeoutMs, launchTimeoutMessage, async () => {
            launchTimedOut = true;
          appendFrontendDiagnosticsLog('runtime', 'warning', '[SceneLaunch] timeout', stringifyRedacted({
              launchAttemptId,
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
              ...(overlayOpenedByLaunch
                ? [toggleSubtitleOverlayWindow().then((runtime) => {
                    overlayOpenedByLaunch = false;
                    setRuntimeSnapshot(runtime);
                  })]
                : []),
            ]);
            try {
              controller.setAudioSnapshot(await getAudioRuntimeSnapshotRuntime());
            } catch {
              // The timeout error remains the user-facing result.
            }
          });
        }
        appendFrontendDiagnosticsLog('runtime', 'info', '[SceneLaunch] ready', stringifyRedacted({
          launchAttemptId,
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
      if (
        mode === 'watch'
        && nextConfig.devices.feedbackLoopPrevention !== 'process-exclusion'
        && watchModeNeedsBridge(nextConfig)
        && isBridgeStartupError(launchError)
      ) {
        const fallback = (await controller.confirmWatchFallback()) ? 'subtitles-only' : 'aec';
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
          const typedFallbackError = fallbackError as SceneLaunchError & { fallbackStage: SceneLaunchStage | null };
          const fallbackCause = typedFallbackError.cause;
          appendFrontendDiagnosticsLog('runtime', 'error', '[WatchFallback] fallback failed', stringifyRedacted({
            originalError: launchError instanceof Error ? launchError.message : String(launchError),
            fallback,
            fallbackStage: typedFallbackError.fallbackStage,
            fallbackError: fallbackCause instanceof Error ? fallbackCause.message : String(fallbackCause),
            nativeSnapshot,
          }));
          controller.pushNotification({
            id: `watch-fallback-failed-${Date.now()}`,
            level: 'error',
            source: 'session',
            message: tagSceneLaunchError(i18n.t('session.watchFallbackFailed', { fallback, cause: fallbackCause instanceof Error ? fallbackCause.message : String(fallbackCause) }), 'session.launch-stage-failed'),
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
          message: tagSceneLaunchError(i18n.t('session.overlayOpenFailed', { error: launchError instanceof Error ? launchError.message : String(launchError) }), 'session.launch-stage-failed'),
          emittedAt: new Date().toISOString(),
        });
      }
      // Watch launches (except overlay open) replace the generic timeout text
      // with an attributable reason: which stage, the last native snapshot, and
      // the recent route marker, plus an outcome-specific next step.
      const failureError = mode === 'watch' && launchStage !== 'subtitle-overlay'
        ? await describeWatchLaunchFailure(launchStage, launchError, routeCommandAccepted)
        : launchError;
      const failureMessage = controller.sceneLaunchFailureMessage(mode, launchStage, failureError);
      const failureCode = failureError instanceof Error && failureError.message === launchTimeoutMessage
        ? 'session.launch-timeout'
        : 'session.launch-stage-failed';
      controller.pushNotification({ id: `scene-launch-${mode}-${Date.now()}`, level: 'error', source: 'session', message: tagSceneLaunchError(failureMessage, failureCode), emittedAt: new Date().toISOString() });
    }
  };

  return { ensureBridgeReady, launchScene, stopAll };
}

export const sceneSessionControllerHelpers = {
  describeWatchLaunchFailure,
  isBridgeStartupError,
  withSceneLaunchTimeout,
};
