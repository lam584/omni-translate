import { useState } from 'react';
import AppIcon from '../components/icons/AppIcon';
import { useTranslation } from 'react-i18next';
import AudioLevelMeter from '../components/audio/AudioLevelMeter';
import PageSectionHeader from '../components/page/PageSectionHeader';
import StatusBadge from '../components/page/StatusBadge';
import {
  clearSubtitleCuesRuntime,
  toggleSubtitleOverlayWindow,
} from '../runtime/audio-runtime';
import { useAppStore } from '../stores/app-store';
import type { AudioRuntimeSnapshot, SubtitleCueRuntime } from '../schema/audio-runtime';
import type { AppConfigDraft } from '../schema/config';
import type { SceneMode } from '../utils/scene-readiness';
import i18n from '../i18n/config';
import { parseRuntimeTimestampMs, useSessionElapsed } from './session/useSessionElapsed';
import { useSceneSessionController } from './session/useSceneSessionController';
import { logSceneLaunchConfig } from './session/logSceneLaunchConfig';
import { getCueDisplaySegments } from './overlay/overlayDomain';
import { appendFrontendDiagnosticsLog } from '../runtime/diagnostics-runtime';

type BusyAction = 'watch-start' | 'conversation-start' | 'overlay' | 'clear-cues' | 'stop' | null;

type WatchFallbackResolver = (subtitlesOnly: boolean) => void;

const TRANSLATION_FAILED_PREFIX = '[\u7ffb\u8bd1\u5931\u8d25]';

function createLaunchAttemptId(mode: SceneMode): string {
  const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${mode}-${id}`;
}

function describeRuntimeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown };
    if (typeof candidate.message === 'string' && candidate.message.trim()) {
      const code = typeof candidate.code === 'string' && candidate.code.trim() ? ` (${candidate.code})` : '';
      return `${candidate.message}${code}`;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

function resolveSceneLabel(mode: SceneMode) {
  if (mode === 'watch') {
    return i18n.t('session.watchMode');
  }

  if (mode === 'game') {
    return i18n.t('providers.labels.scenario.game');
  }

  return i18n.t('session.conversationMode');
}

function formatElapsed(seconds: number): string {
  if (!Number.isFinite(seconds)) {
    return '00:00';
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatLatencyMs(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return '--';
  }
  return `${Math.round(value)} ms`;
}

function formatRuntimeClock(value: string | null | undefined): string {
  const ms = parseRuntimeTimestampMs(value);
  if (ms == null) {
    return '--:--:--';
  }
  return new Date(ms).toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatCueTiming(cue: SubtitleCueRuntime): string {
  const started = formatRuntimeClock(cue.startedAt);
  const ended = formatRuntimeClock(cue.endedAt);
  if (started === ended || ended === '--:--:--') {
    return i18n.t('session.cueStartedAt', { started });
  }
  return i18n.t('session.cueTimeRange', { started, ended });
}

function resolveVoiceModelRuntime(inboundVoiceModelId: string) {
  const voiceModelRaw = inboundVoiceModelId.includes('::')
    ? inboundVoiceModelId.split('::').pop()!
    : inboundVoiceModelId;
  const modelLower = voiceModelRaw.toLowerCase();

  return {
    voiceModelRaw,
    isOmniModel: modelLower.includes('realtime') && (modelLower.includes('omni') || modelLower.includes('livetranslate')),
  };
}

function resolveSceneVoiceModelId(mode: SceneMode, configDraft: AppConfigDraft): string {
  return mode === 'voice-room'
    ? configDraft.devices.outboundVoiceModelId
    : configDraft.devices.inboundVoiceModelId;
}

function getSceneLaunchConfigurationProblem(
  mode: SceneMode,
  configDraft: AppConfigDraft,
  audioSnapshot: AudioRuntimeSnapshot,
): 'model' | 'input-device' | 'playback-device' | null {
  if (!resolveSceneVoiceModelId(mode, configDraft).trim()) return 'model';
  if (mode === 'voice-room' && !configDraft.devices.inboundVoiceModelId.trim()) return 'model';
  if (mode === 'voice-room') {
    const selectedInput = configDraft.devices.inputDeviceId;
    if (!selectedInput || !audioSnapshot.captureDevices.some((device) => device.deviceId === selectedInput)) {
      return 'input-device';
    }
  }
  if (mode === 'watch' || mode === 'voice-room') {
    // Audio Routing and the native speech output both use outputDeviceId.
    // playbackDeviceId is a legacy preference whose default placeholder is not
    // a Windows endpoint ID, so validating it reports healthy devices missing.
    // Windows endpoint IDs may change after a driver update, USB reconnect, or
    // default-device switch. The native route already falls back to the current
    // default endpoint when the persisted ID is stale.
    if (audioSnapshot.renderDevices.length === 0) {
      return 'playback-device';
    }
  }
  return null;
}

function getSceneLaunchConfigurationMessage(
  problem: Exclude<ReturnType<typeof getSceneLaunchConfigurationProblem>, null>,
  chinese: boolean,
): string {
  const messages = {
    model: chinese
      ? '请先在“音频路由”中选择适用于当前场景的语音模型。'
      : 'Select a compatible voice model in Audio Routing before starting.',
    'input-device': chinese
      ? '当前麦克风不可用，请在“音频路由”中重新选择输入设备。'
      : 'The selected microphone is unavailable. Choose an input device in Audio Routing.',
    'playback-device': chinese
      ? '当前系统播放设备不可用，请在“音频路由”中重新选择输出设备。'
      : 'The selected playback device is unavailable. Choose an output device in Audio Routing.',
  } as const;
  return messages[problem];
}

export function diagnosticsReadyPatchForMode(sceneMode: SceneMode) {
  return sceneMode === 'watch'
    ? { deviceStatus: 'ready' as const }
    : { deviceStatus: 'ready' as const, driverStatus: 'ready' as const };
}

export function WatchFallbackDialog({ onResolve }: { onResolve: WatchFallbackResolver }) {
  const { t } = useTranslation();
  return <div className="benchmark-modal-backdrop" onClick={() => onResolve(false)}>
    <div className="benchmark-modal watch-fallback-modal" role="dialog" aria-modal="true"
      aria-label={t('session.watchMode')} onClick={(event) => event.stopPropagation()}>
      <div className="benchmark-modal-head"><div><p>{t('session.virtualDriverFallbackConfirm')}</p></div></div>
      <div className="control-toolbar">
        <button className="action-button" onClick={() => onResolve(true)} type="button">{t('common.confirm')}</button>
        <button className="icon-button" onClick={() => onResolve(false)} type="button">{t('common.cancel')}</button>
      </div>
    </div>
  </div>;
}

function describeSceneLaunchStage(stage: string | null) {
  switch (stage) {
    case 'omni-preconnect':
      return 'Omni 预连接';
    case 'bridge-ready':
      return 'Bridge/驱动准备';
    case 'inbound-route':
      return '系统音频采集';
    case 'outbound-route':
      return '麦克风采集';
    case 'translate-worker':
      return '翻译引擎';
    case 'speech-dispatch':
      return '语音播报';
    case 'subtitle-overlay':
      return '字幕浮窗';
    case 'fallback-route':
      return '看片降级采集';
    default:
      return '启动流程';
  }
}

function resolveSceneSpeechPatch(mode: SceneMode, configDraft: AppConfigDraft, isOmniModel: boolean) {
  const speechEnabled = Boolean(configDraft.speech?.enabled || configDraft.devices.outputSpeechEnabled);

  if (mode === 'game') {
    return {
      enabled: true,
      outputTarget: 'speaker' as const,
      localPlaybackEnabled: true,
      virtualMicOutputEnabled: false,
      status: 'ready' as const,
    };
  }

  if (mode === 'voice-room') {
    return {
      enabled: true,
      outputTarget: 'speaker' as const,
      localPlaybackEnabled: true,
      virtualMicOutputEnabled: false,
      status: 'ready' as const,
    };
  }

  return {
    enabled: isOmniModel ? speechEnabled : false,
    outputTarget: configDraft.speech?.outputTarget ?? ('speaker' as const),
    localPlaybackEnabled: configDraft.speech?.localPlaybackEnabled ?? true,
    virtualMicOutputEnabled: configDraft.speech?.virtualMicOutputEnabled ?? false,
    status: 'ready' as const,
  };
}

function CueStatusBadge({ cue }: { cue: SubtitleCueRuntime }) {
  const { t } = useTranslation();

  if (!cue.committed) {
    return <span className="audio-level-meter-vad audio-level-meter-vad-speech">{t('session.translating')}</span>;
  }
  if (cue.translatedText.startsWith(TRANSLATION_FAILED_PREFIX)) {
    return <span className="cue-queue-error">{t('session.failed')}</span>;
  }
  if (cue.translatedText) {
    return <span className="audio-level-meter-vad audio-level-meter-vad-speech">{t('session.translated')}</span>;
  }
  return <span className="cue-queue-error">{t('session.translationFailed')}</span>;
}

function getSessionCueDisplaySegments(cue: SubtitleCueRuntime) {
  const sourceText = cue.displaySourceText || cue.sourceText;
  const normalizedSource = sourceText.replace(/\s+/gu, '');
  const segmentedSource = cue.displaySegments?.map((segment) => segment.sourceText).join('').replace(/\s+/gu, '') ?? '';
  const normalizedTranslation = cue.translatedText.replace(/\s+/gu, '');
  const segmentedTranslation = cue.displaySegments?.map((segment) => segment.translatedText).join('').replace(/\s+/gu, '') ?? '';

  if (cue.displaySegments?.length && segmentedSource === normalizedSource && segmentedTranslation === normalizedTranslation) {
    return getCueDisplaySegments(cue);
  }

  return getCueDisplaySegments({
    ...cue,
    displaySegments: [{
      sourceText,
      translatedText: cue.translatedText,
      pending: Boolean(sourceText) && !cue.translatedText && !cue.committed,
    }],
  });
}

function CueSegmentRows({ cue, current = false }: { cue: SubtitleCueRuntime; current?: boolean }) {
  const { t } = useTranslation();
  const segments = getSessionCueDisplaySegments(cue);

  if (segments.length === 0) {
    return <p className="live-text-translation">{cue.committed ? t('session.translationFailed') : t('session.callingLlm')}</p>;
  }

  return (
    <div className={current ? 'live-caption-segments live-caption-segments-current' : 'live-caption-segments'}>
      {segments.map((segment) => (
        <div className="live-caption-segment" key={segment.id}>
          {segment.sourceText && <p className={current ? 'live-text-source' : 'cue-queue-source'}>{segment.sourceText}</p>}
          {segment.translatedText ? (
            <p className={segment.translatedText.startsWith(TRANSLATION_FAILED_PREFIX) ? 'cue-queue-error' : current ? 'live-text-translation' : 'cue-queue-translation'}>
              {segment.translatedText}
            </p>
          ) : cue.committed ? (
            <p className="cue-queue-error">{t('session.translationFailed')}</p>
          ) : (
            <p className="live-caption-segment-pending">{t('session.callingLlm')}</p>
          )}
        </div>
      ))}
    </div>
  );
}

export const realTimeSessionPageHelpers = {
  CueSegmentRows,
  createLaunchAttemptId,
  parseRuntimeTimestampMs,
  resolveSceneLabel,
  formatElapsed,
  formatLatencyMs,
  formatRuntimeClock,
  formatCueTiming,
  resolveVoiceModelRuntime,
  resolveSceneVoiceModelId,
  getSceneLaunchConfigurationProblem,
  getSceneLaunchConfigurationMessage,
  describeSceneLaunchStage,
  resolveSceneSpeechPatch,
  logSceneLaunchConfig,
  CueStatusBadge,
  getSessionCueDisplaySegments,
  describeRuntimeError,
};

function RealTimeSessionPage() {
  const { t } = useTranslation();
  const configDraft = useAppStore((state) => state.configDraft);
  const runtimeSnapshot = useAppStore((state) => state.runtimeSnapshot);
  const audioRuntimeSnapshot = useAppStore((state) => state.audioRuntimeSnapshot);
  const setRuntimeSnapshot = useAppStore((state) => state.setRuntimeSnapshot);
  const setAudioRuntimeSnapshot = useAppStore((state) => state.setAudioRuntimeSnapshot);
  const updateDeviceDraft = useAppStore((state) => state.updateDeviceDraft);
  const updateSpeechDraft = useAppStore((state) => state.updateSpeechDraft);
  const updateDiagnosticsDraft = useAppStore((state) => state.updateDiagnosticsDraft);
  const pushRuntimeNotification = useAppStore((state) => state.pushRuntimeNotification);

  const overlayWindow = runtimeSnapshot.windows.find((item) => item.label === 'subtitle-overlay');
  const activeCue = audioRuntimeSnapshot.subtitleOverlay.activeCue;
  const modelTraceSummary = runtimeSnapshot.diagnostics.modelTraceSummary;
  const latestModelTraceCall = modelTraceSummary.recentCalls[0] ?? null;
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [sessionLaunchProblem, setSessionLaunchProblem] = useState<string | null>(null);
  const [watchFallbackResolver, setWatchFallbackResolver] = useState<WatchFallbackResolver | null>(null);

  const hasSpeechActivity = audioRuntimeSnapshot.speech.dispatchState !== 'idle';
  const isSessionRunning = audioRuntimeSnapshot.inbound.streamBound || audioRuntimeSnapshot.outbound.streamBound;
  // sttConnected also represents the idle Omni preconnect performed during
  // bootstrap. A ready provider socket has no route ownership and must not
  // disable scene launch or enable Stop before a user-started chain exists.
  const hasActiveChain = isSessionRunning || hasSpeechActivity;
  const runningMode = hasActiveChain ? configDraft.devices.routeMode : null;
  const firstTranslationAverageMs = audioRuntimeSnapshot.subtitleOverlay.firstTranslationAverageMs;
  const firstTranslationLastMs = audioRuntimeSnapshot.subtitleOverlay.firstTranslationLastMs;
  const firstTranslationSampleCount = audioRuntimeSnapshot.subtitleOverlay.firstTranslationSampleCount;

  const sessionElapsed = useSessionElapsed(audioRuntimeSnapshot.sessionStartedAt, isSessionRunning);

  const runBusyAction = async (nextBusyAction: Exclude<BusyAction, null>, action: () => Promise<void>) => {
    setBusyAction(nextBusyAction);

    try {
      await action();
    } finally {
      setBusyAction(null);
    }
  };

  const resolveWatchFallback = (subtitlesOnly: boolean) => {
    setWatchFallbackResolver((resolve: WatchFallbackResolver | null) => {
      resolve?.(subtitlesOnly);
      return null;
    });
  };

  const { launchScene, stopAll } = useSceneSessionController({
    runtimeSnapshot,
    setRuntimeSnapshot,
    setAudioSnapshot: setAudioRuntimeSnapshot,
    updateDeviceDraft,
    updateSpeechDraft,
    updateDiagnosticsReady: (sceneMode) => updateDiagnosticsDraft(diagnosticsReadyPatchForMode(sceneMode)),
    pushNotification: pushRuntimeNotification,
    runBusyAction,
    confirmWatchFallback: () =>
      new Promise<boolean>((resolve) => {
        // The bridge/driver fallback needs a user decision after a failed launch.
        // Clear any busy indicator first so the UI stays responsive, then defer
        // to an in-app dialog instead of the event-loop-blocking window.confirm.
        setBusyAction(null);
        setWatchFallbackResolver(() => resolve);
      }),
    sceneLaunchTimeoutMessage: (seconds) => t('session.startSlowWarning', { seconds }),
    sceneLaunchFailureMessage: (sceneMode, stage, error) => {
      const message = t('session.sceneLaunchFailed', {
        scene: resolveSceneLabel(sceneMode), stage: describeSceneLaunchStage(stage),
        error: describeRuntimeError(error),
      });
      setSessionLaunchProblem(message);
      return message;
    },
  });

  const handleSceneLaunch = async (mode: SceneMode) => {
    const launchAttemptId = createLaunchAttemptId(mode);
    setSessionLaunchProblem(null);
    appendFrontendDiagnosticsLog('runtime', 'info', '[SceneLaunch] click accepted', JSON.stringify({
      launchAttemptId,
      mode,
      sttConnected: audioRuntimeSnapshot.sttConnected,
      inboundBound: audioRuntimeSnapshot.inbound.streamBound,
      outboundBound: audioRuntimeSnapshot.outbound.streamBound,
    }));
    const configurationProblem = getSceneLaunchConfigurationProblem(mode, configDraft, audioRuntimeSnapshot);
    if (configurationProblem) {
      const chinese = i18n.language.toLowerCase().startsWith('zh');
      const message = getSceneLaunchConfigurationMessage(configurationProblem, chinese);
      setSessionLaunchProblem(message);
      appendFrontendDiagnosticsLog('runtime', 'warning', '[SceneLaunch] validation blocked', JSON.stringify({
        launchAttemptId,
        mode,
        reason: configurationProblem,
      }));
      return;
    }
    const { isOmniModel } = resolveVoiceModelRuntime(resolveSceneVoiceModelId(mode, configDraft));
    const speechPatch = resolveSceneSpeechPatch(mode, configDraft, isOmniModel);
    const secondarySubtitleTranslationEnabled =
      configDraft.devices.subtitleTranslationMode === 'secondary' && Boolean(configDraft.devices.subtitleTranslationModelId);
    logSceneLaunchConfig(mode, configDraft, runtimeSnapshot, audioRuntimeSnapshot, {
      speechPatch, isOmniModel, secondarySubtitleTranslationEnabled,
    });
    await launchScene({
      launchAttemptId, mode, configDraft, audioSnapshot: audioRuntimeSnapshot, overlayVisible: Boolean(overlayWindow?.visible),
      isOmniModel, speechPatch, secondarySubtitleTranslationEnabled,
    });
  };

  const handleSceneLaunchClick = (mode: SceneMode) => {
    void handleSceneLaunch(mode).catch((error) => {
      const detail = describeRuntimeError(error);
      const message = t('session.sceneLaunchFailed', {
        scene: resolveSceneLabel(mode),
        stage: describeSceneLaunchStage(null),
        error: detail,
      });
      setSessionLaunchProblem(message);
      pushRuntimeNotification({
        id: `scene-launch-handler-${mode}-${Date.now()}`,
        level: 'error',
        source: 'session',
        message,
        emittedAt: new Date().toISOString(),
      });
      appendFrontendDiagnosticsLog('runtime', 'error', '[SceneLaunch] click handler rejected', JSON.stringify({ mode, error: detail }));
    });
  };

  const handleStopAll = async () => {
    await stopAll({
      audioSnapshot: audioRuntimeSnapshot,
      hasSpeechActivity,
      setAudioSnapshot: setAudioRuntimeSnapshot,
      pushNotification: pushRuntimeNotification,
      runBusyAction,
    });
  };

  return (
    <div className="page-shell realtime-session-page">
      <section className="page-layout page-layout-single realtime-session-layout">
        <article className="content-card page-card compact-card control-hero-card">
          <PageSectionHeader
            className="control-hero-header"
            title={t('session.controlTitle')}
          />
          <div className="provider-list">
            <button aria-pressed={runningMode === 'watch'} className={runningMode === 'watch' ? 'action-button action-button-active' : 'action-button'} disabled={busyAction !== null || hasActiveChain} onClick={() => handleSceneLaunchClick('watch')} type="button">
              {busyAction === 'watch-start' ? t('session.starting') : t('session.watchButton')}
            </button>
            <button aria-pressed={runningMode === 'voice-room'} className={runningMode === 'voice-room' ? 'action-button action-button-active' : 'action-button'} disabled={busyAction !== null || hasActiveChain} onClick={() => handleSceneLaunchClick('voice-room')} type="button">
              {busyAction === 'conversation-start' ? t('session.starting') : t('session.conversationMode')}
            </button>
          </div>
          {busyAction === 'stop' ? <p role="status">正在停止上一条链路，请稍候…</p> : null}
          {isSessionRunning && (
            <div className="session-timer">
              <AppIcon name="clock" size={14} />
              <span className="session-timer-text">{t('session.runningFor', { elapsed: formatElapsed(sessionElapsed) })}</span>
            </div>
          )}
          {isSessionRunning && audioRuntimeSnapshot.inbound.streamBound && (
            <AudioLevelMeter
              energyDb={audioRuntimeSnapshot.inbound.lastEnergyDb}
              label={t('session.systemAudio')}
              vadState={audioRuntimeSnapshot.inbound.vadState}
            />
          )}
          {isSessionRunning && audioRuntimeSnapshot.outbound.streamBound && (
            <AudioLevelMeter
              energyDb={audioRuntimeSnapshot.outbound.lastEnergyDb}
              label={t('session.microphoneAudio')}
              vadState={audioRuntimeSnapshot.outbound.vadState}
            />
          )}
          <div className="control-toolbar">
            <button className={`icon-button ${hasActiveChain ? 'icon-button-danger' : ''}`} disabled={busyAction !== null || !hasActiveChain} onClick={() => void handleStopAll()} type="button">
              <AppIcon name="stop" size={14} />
              {isSessionRunning ? t('session.stopWithElapsed', { elapsed: formatElapsed(sessionElapsed) }) : t('session.stopAll')}
            </button>
            <button
              className="icon-button"
              disabled={busyAction !== null}
              onClick={() =>
                void runBusyAction('overlay', async () => {
                  const snapshot = await toggleSubtitleOverlayWindow();
                  setRuntimeSnapshot(snapshot);
                })
              }
              type="button"
            >
              <AppIcon name="subtitles" size={14} />
              {overlayWindow?.visible ? t('session.hideOverlay') : t('session.showOverlay')}
            </button>
          </div>
          {isSessionRunning && (
            <div className="session-runtime-metrics">
              <div className="audio-status-grid audio-status-grid-summary">
              <div className="audio-status-item">
                <span className="audio-status-label">{t('session.avgFirstToken')}</span>
                <span className="audio-status-value">{formatLatencyMs(firstTranslationAverageMs)}</span>
              </div>
              <div className="audio-status-item">
                <span className="audio-status-label">{t('session.lastFirstToken')}</span>
                <span className="audio-status-value">{formatLatencyMs(firstTranslationLastMs)}</span>
              </div>
              <div className="audio-status-item">
                <span className="audio-status-label">{t('session.firstTokenSamples')}</span>
                <span className="audio-status-value">{firstTranslationSampleCount}</span>
              </div>
              </div>
              {audioRuntimeSnapshot.inbound.streamBound && (
                <section className="audio-route-status-group">
                  <h4>{t('session.systemAudio')}</h4>
                  <div className="audio-status-grid">
                  <div className="audio-status-item">
                    <span className="audio-status-label">{t('session.captureState')}</span>
                    <span className="audio-status-value">{audioRuntimeSnapshot.inbound.captureState}</span>
                  </div>
                  <div className="audio-status-item">
                    <span className="audio-status-label">{t('session.bufferState')}</span>
                    <span className="audio-status-value">{audioRuntimeSnapshot.inbound.preBufferState}</span>
                  </div>
                  <div className="audio-status-item">
                    <span className="audio-status-label">{t('session.framesCaptured')}</span>
                    <span className="audio-status-value">{audioRuntimeSnapshot.inbound.framesCaptured.toLocaleString()}</span>
                  </div>
                  <div className="audio-status-item">
                    <span className="audio-status-label">{t('session.speechSegments')}</span>
                    <span className="audio-status-value">{audioRuntimeSnapshot.inbound.segmentCount}</span>
                  </div>
                  </div>
                </section>
              )}
              {audioRuntimeSnapshot.outbound.streamBound && (
                <section className="audio-route-status-group">
                  <h4>{t('session.microphoneAudio')}</h4>
                  <div className="audio-status-grid">
                  <div className="audio-status-item">
                    <span className="audio-status-label">{t('session.captureState')}</span>
                    <span className="audio-status-value">{audioRuntimeSnapshot.outbound.captureState}</span>
                  </div>
                  <div className="audio-status-item">
                    <span className="audio-status-label">{t('session.bufferState')}</span>
                    <span className="audio-status-value">{audioRuntimeSnapshot.outbound.preBufferState}</span>
                  </div>
                  <div className="audio-status-item">
                    <span className="audio-status-label">{t('session.framesCaptured')}</span>
                    <span className="audio-status-value">{audioRuntimeSnapshot.outbound.framesCaptured.toLocaleString()}</span>
                  </div>
                  <div className="audio-status-item">
                    <span className="audio-status-label">{t('session.speechSegments')}</span>
                    <span className="audio-status-value">{audioRuntimeSnapshot.outbound.segmentCount}</span>
                  </div>
                  </div>
                </section>
              )}
            </div>
          )}
          {audioRuntimeSnapshot.inbound.lastError && (
            <p className="cue-queue-error" role="alert">
              {t('session.systemAudioError', { error: audioRuntimeSnapshot.inbound.lastError })}
              {audioRuntimeSnapshot.inbound.recommendedAction === 'restart-bridge' && t('session.restartBridgeHint')}
            </p>
          )}
          {sessionLaunchProblem && !isSessionRunning && (
            <div className="session-launch-feedback session-launch-feedback-error" role="alert">
              <AppIcon name="alert" size={15} />
              <span>{sessionLaunchProblem}</span>
            </div>
          )}
          <div className="control-toolbar">
            <button
              className="icon-button icon-button-danger"
              disabled={busyAction !== null}
              onClick={() =>
                void runBusyAction('clear-cues', async () => {
                  const snapshot = await clearSubtitleCuesRuntime();
                  setAudioRuntimeSnapshot(snapshot);
                })
              }
              type="button"
            >
              <AppIcon name="trash" size={14} />
              {t('session.clearSubtitles')}
            </button>
          </div>
        </article>

        <article className="content-card page-card compact-card live-text-card">
          <div className="section-heading compact-heading">
            <h3>{t('session.modelTraceTitle')}</h3>
            <StatusBadge label={modelTraceSummary.failedCalls > 0 ? t('session.failedCount', { count: modelTraceSummary.failedCalls }) : t('session.normal')} tone={modelTraceSummary.failedCalls > 0 ? 'warning' : 'ready'} />
          </div>
          {latestModelTraceCall ? (
            <div className="audio-status-grid">
              <div className="audio-status-item">
                <span className="audio-status-label">{t('session.totalCalls')}</span>
                <span className="audio-status-value">{modelTraceSummary.totalCalls.toLocaleString()}</span>
              </div>
              <div className="audio-status-item">
                <span className="audio-status-label">{t('session.successFailure')}</span>
                <span className="audio-status-value">
                  {modelTraceSummary.succeededCalls.toLocaleString()} / {modelTraceSummary.failedCalls.toLocaleString()}
                </span>
              </div>
              <div className="audio-status-item">
                <span className="audio-status-label">{t('session.currentModel')}</span>
                <span className="audio-status-value">{latestModelTraceCall.model || '—'}</span>
              </div>
              <div className="audio-status-item">
                <span className="audio-status-label">{t('session.lastDuration')}</span>
                <span className="audio-status-value">{latestModelTraceCall.elapsedMs == null ? latestModelTraceCall.status : `${latestModelTraceCall.elapsedMs} ms`}</span>
              </div>
              <div className="audio-status-item">
                <span className="audio-status-label">{t('session.lastCue')}</span>
                <span className="audio-status-value">{latestModelTraceCall.cueId ?? '-'}</span>
              </div>
            </div>
          ) : (
            <div className="console-event-item">
              <div className="compact-info-head">
                <strong>{t('session.noModelCalls')}</strong>
                <StatusBadge label={t('session.empty')} tone="pending" />
              </div>
              <p>{t('session.modelTraceEmpty')}</p>
            </div>
          )}
          {modelTraceSummary.lastError && <p className="cue-queue-error">{t('session.recentError', { error: modelTraceSummary.lastError })}</p>}
        </article>

        <article className="content-card page-card compact-card live-text-card">
          <div className="section-heading compact-heading">
            <h3>{t('session.currentSubtitle')}</h3>
          </div>
          {activeCue ? (
            <div className="console-event-item live-text-card">
              <div className="live-text-head">
                <strong>{activeCue.committed ? t('session.translated') : t('session.translating')}</strong>
                <StatusBadge label={t('session.queueDepth', { count: audioRuntimeSnapshot.subtitleOverlay.queueDepth })} tone={audioRuntimeSnapshot.subtitleOverlay.queueDepth > 0 ? 'warning' : 'ready'} />
              </div>
              <CueSegmentRows cue={activeCue} current />
            </div>
          ) : (
            <div className="console-event-item">
              <div className="compact-info-head">
                <strong>{t('session.noActiveSubtitle')}</strong>
                <StatusBadge label={t('session.empty')} tone="pending" />
              </div>
              <p>{t('session.currentSubtitleEmpty')}</p>
            </div>
          )}
        </article>

        <article className="content-card page-card compact-card live-text-card">
          <div className="section-heading compact-heading">
            <h3>{t('session.subtitleQueue')}</h3>
            {audioRuntimeSnapshot.subtitleOverlay.droppedCueCount > 0 && (
              <StatusBadge label={t('session.droppedCueCount', { count: audioRuntimeSnapshot.subtitleOverlay.droppedCueCount })} tone="warning" />
            )}
          </div>
          {audioRuntimeSnapshot.subtitleOverlay.recentCues.length > 0 ? (
            <div className="cue-queue-list">
              {audioRuntimeSnapshot.subtitleOverlay.recentCues.map((cue) => (
                <div key={cue.cueId} className="cue-queue-item">
                  <div className="cue-queue-item-head">
                    <span className="cue-queue-item-id">{cue.cueId}</span>
                    <CueStatusBadge cue={cue} />
                  </div>
                  <div className="cue-queue-time">{formatCueTiming(cue)}</div>
                  <CueSegmentRows cue={cue} />
                </div>
              ))}
            </div>
          ) : (
            <div className="console-event-item console-event-item-empty">
              <div className="compact-info-head">
                <strong>{t('session.noSubtitleEvents')}</strong>
                <StatusBadge label={t('session.empty')} tone="pending" />
              </div>
              <p>{t('session.subtitleQueueEmpty')}</p>
            </div>
          )}
        </article>
      </section>

      {watchFallbackResolver && <WatchFallbackDialog onResolve={resolveWatchFallback} />}
    </div>
  );
}

export default RealTimeSessionPage;
