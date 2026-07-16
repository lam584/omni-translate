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
import type { SubtitleCueRuntime } from '../schema/audio-runtime';
import type { AppConfigDraft } from '../schema/config';
import type { SceneMode } from '../utils/scene-readiness';
import i18n from '../i18n/config';
import { parseRuntimeTimestampMs, useSessionElapsed } from './session/useSessionElapsed';
import { useSceneSessionController } from './session/useSceneSessionController';
import { logSceneLaunchConfig } from './session/logSceneLaunchConfig';
import { getCueDisplaySegments } from './overlay/overlayDomain';

type BusyAction = 'watch-start' | 'conversation-start' | 'overlay' | 'clear-cues' | 'stop' | null;

const TRANSLATION_FAILED_PREFIX = '[\u7ffb\u8bd1\u5931\u8d25]';

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
    return i18n.t('session.conversationMode');
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
          ) : segment.pending ? (
            <p className="live-caption-segment-pending">{t('session.callingLlm')}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export const realTimeSessionPageHelpers = {
  parseRuntimeTimestampMs,
  resolveSceneLabel,
  formatElapsed,
  formatLatencyMs,
  formatRuntimeClock,
  formatCueTiming,
  resolveVoiceModelRuntime,
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

  const hasSpeechActivity = audioRuntimeSnapshot.speech.dispatchState !== 'idle';
  const isSessionRunning = audioRuntimeSnapshot.inbound.streamBound || audioRuntimeSnapshot.outbound.streamBound;
  const hasActiveChain = isSessionRunning || hasSpeechActivity || audioRuntimeSnapshot.sttConnected;
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

  const { launchScene, stopAll } = useSceneSessionController({
    runtimeSnapshot,
    setRuntimeSnapshot,
    setAudioSnapshot: setAudioRuntimeSnapshot,
    updateDeviceDraft,
    updateSpeechDraft,
    updateDiagnosticsReady: (sceneMode) => updateDiagnosticsDraft(sceneMode === 'watch'
      ? { deviceStatus: 'ready' }
      : { deviceStatus: 'ready', driverStatus: 'ready' }),
    pushNotification: pushRuntimeNotification,
    runBusyAction,
    confirmWatchFallback: () => window.confirm(t('session.virtualDriverFallbackConfirm')),
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
    setSessionLaunchProblem(null);
    const { isOmniModel } = resolveVoiceModelRuntime(configDraft.devices.inboundVoiceModelId);
    const speechPatch = resolveSceneSpeechPatch(mode, configDraft, isOmniModel);
    const secondarySubtitleTranslationEnabled =
      configDraft.devices.subtitleTranslationMode === 'secondary' && Boolean(configDraft.devices.subtitleTranslationModelId);
    logSceneLaunchConfig(mode, configDraft, runtimeSnapshot, audioRuntimeSnapshot, {
      speechPatch, isOmniModel, secondarySubtitleTranslationEnabled,
    });
    await launchScene({
      mode, configDraft, audioSnapshot: audioRuntimeSnapshot, overlayVisible: Boolean(overlayWindow?.visible),
      isOmniModel, speechPatch, secondarySubtitleTranslationEnabled,
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
            <button aria-pressed={runningMode === 'watch'} className={runningMode === 'watch' ? 'action-button action-button-active' : 'action-button'} disabled={busyAction !== null} onClick={() => void handleSceneLaunch('watch')} type="button">
              {busyAction === 'watch-start' ? t('session.starting') : t('session.watchButton')}
            </button>
            <button aria-pressed={runningMode === 'game' || runningMode === 'voice-room'} className={runningMode === 'game' || runningMode === 'voice-room' ? 'action-button action-button-active' : 'action-button'} disabled={busyAction !== null} onClick={() => void handleSceneLaunch('game')} type="button">
              {busyAction === 'conversation-start' ? t('session.starting') : t('session.conversationMode')}
            </button>
          </div>
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
    </div>
  );
}

export default RealTimeSessionPage;
