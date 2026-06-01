import { useState, useEffect, useRef } from 'react';
import AppIcon from '../components/icons/AppIcon';
import AudioLevelMeter from '../components/audio/AudioLevelMeter';
import PageSectionHeader from '../components/page/PageSectionHeader';
import StatusBadge from '../components/page/StatusBadge';
import {
  clearSubtitleCuesRuntime,
  showSubtitleOverlayWindow,
  startAudioRouteRuntime,
  startSpeechDispatchRuntime,
  startTranslateWorkerRuntime,
  stopAudioRouteRuntime,
  stopSpeechDispatchRuntime,
  stopTranslateWorkerRuntime,
  toggleSubtitleOverlayWindow,
} from '../runtime/audio-runtime';
import { installDriverRuntime, repairDriverRuntime, startBridgeServiceRuntime } from '../runtime/bridge-runtime';
import { useAppStore } from '../stores/app-store';
import type { SubtitleCueRuntime } from '../schema/audio-runtime';
import type { AppConfigDraft } from '../schema/config';
import type { SceneMode } from '../utils/scene-readiness';

type BusyAction = 'watch-start' | 'conversation-start' | 'overlay' | 'clear-cues' | null;

function parseRuntimeTimestampMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const normalized = value.startsWith('unix-ms:')
    ? value.slice('unix-ms:'.length)
    : value.startsWith('unix:')
      ? value.slice('unix:'.length)
      : value;
  const numeric = Number(normalized);

  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveSceneLabel(mode: SceneMode) {
  if (mode === 'watch') {
    return '看片模式';
  }

  if (mode === 'game') {
    return '对话模式';
  }

  return '对话模式';
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

function resolveSceneSpeechPatch(mode: SceneMode, configDraft: AppConfigDraft, isOmniModel: boolean) {
  const speechEnabled = Boolean(configDraft.speech?.enabled || configDraft.devices.outputSpeechEnabled);

  if (mode === 'game') {
    return {
      enabled: true,
      outputTarget: 'both' as const,
      localPlaybackEnabled: true,
      virtualMicOutputEnabled: true,
      status: 'ready' as const,
    };
  }

  if (mode === 'voice-room') {
    return {
      enabled: true,
      outputTarget: 'virtual-mic' as const,
      localPlaybackEnabled: false,
      virtualMicOutputEnabled: true,
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
  if (!cue.committed) {
    return <span className="audio-level-meter-vad audio-level-meter-vad-speech">翻译中...</span>;
  }
  if (cue.translatedText.startsWith('[翻译失败]')) {
    return <span className="cue-queue-error">失败</span>;
  }
  if (cue.translatedText) {
    return <span className="audio-level-meter-vad audio-level-meter-vad-speech">已翻译</span>;
  }
  return <span className="cue-queue-error">翻译失败</span>;
}

export const realTimeSessionPageHelpers = {
  parseRuntimeTimestampMs,
  resolveSceneLabel,
  formatElapsed,
  formatLatencyMs,
  resolveVoiceModelRuntime,
  resolveSceneSpeechPatch,
  CueStatusBadge,
};

function RealTimeSessionPage() {
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
  const activeCueSourceText = activeCue ? activeCue.displaySourceText || activeCue.sourceText : '';
  const modelTraceSummary = runtimeSnapshot.diagnostics.modelTraceSummary;
  const latestModelTraceCall = modelTraceSummary.recentCalls[0] ?? null;
  const [busyAction, setBusyAction] = useState<BusyAction>(null);

  const hasSpeechActivity = audioRuntimeSnapshot.speech.dispatchState !== 'idle';
  const canStopAll = audioRuntimeSnapshot.inbound.streamBound || audioRuntimeSnapshot.outbound.streamBound || hasSpeechActivity;
  const isSessionRunning = audioRuntimeSnapshot.inbound.streamBound || audioRuntimeSnapshot.outbound.streamBound;
  const firstTranslationAverageMs = audioRuntimeSnapshot.subtitleOverlay.firstTranslationAverageMs;
  const firstTranslationLastMs = audioRuntimeSnapshot.subtitleOverlay.firstTranslationLastMs;
  const firstTranslationSampleCount = audioRuntimeSnapshot.subtitleOverlay.firstTranslationSampleCount;

  const [sessionElapsed, setSessionElapsed] = useState(() => {
    if (!audioRuntimeSnapshot.inbound.streamBound && !audioRuntimeSnapshot.outbound.streamBound) {
      return 0;
    }

    const startedAtMs = parseRuntimeTimestampMs(audioRuntimeSnapshot.sessionStartedAt);
    return startedAtMs === null ? 0 : Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const updateElapsedFromStart = () => {
      const startedAtMs = parseRuntimeTimestampMs(audioRuntimeSnapshot.sessionStartedAt);
      setSessionElapsed(startedAtMs === null ? 0 : Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)));
    };

    if (isSessionRunning) {
      updateElapsedFromStart();

      if (!timerRef.current) {
        timerRef.current = setInterval(() => {
          updateElapsedFromStart();
        }, 1000);
      }
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setSessionElapsed(0);
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [audioRuntimeSnapshot.sessionStartedAt, isSessionRunning]);

  const runBusyAction = async (nextBusyAction: Exclude<BusyAction, null>, action: () => Promise<void>) => {
    setBusyAction(nextBusyAction);

    try {
      await action();
    } finally {
      setBusyAction(null);
    }
  };

  const ensureBridgeReady = async (mode: SceneMode, nextConfig: typeof configDraft) => {
    if (mode === 'watch') {
      const needsBridge =
        nextConfig.devices.feedbackLoopPrevention === 'virtual-driver' ||
        nextConfig.devices.virtualMicOutputEnabled ||
        nextConfig.speech?.outputTarget === 'virtual-mic' ||
        nextConfig.speech?.outputTarget === 'both';
      if (!needsBridge) {
        return runtimeSnapshot;
      }
    }

    let latestRuntime = runtimeSnapshot;

    if (latestRuntime.bridge.driverHealth === 'not-installed') {
      const installed = await installDriverRuntime(nextConfig);
      setRuntimeSnapshot(installed);
      return installed;
    }

    if (latestRuntime.bridge.driverHealth !== 'running') {
      const repaired = await repairDriverRuntime(
        latestRuntime.bridge.recommendedAction === 'rollback-driver' ? 'rollback-driver' : 'reinstall-driver',
        nextConfig,
      );
      setRuntimeSnapshot(repaired);
      latestRuntime = repaired;
    }

    if (latestRuntime.bridge.bridgeState !== 'running') {
      const started = await startBridgeServiceRuntime(nextConfig);
      setRuntimeSnapshot(started);
      return started;
    }

    return latestRuntime;
  };

  const startWatchFallback = async (fallback: 'subtitles-only' | 'aec') => {
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
    const fallbackConfig = {
      ...configDraft,
      devices: { ...configDraft.devices, ...devicesPatch },
      speech: { ...configDraft.speech, ...speechPatch },
    };
    updateDeviceDraft(devicesPatch);
    updateSpeechDraft(speechPatch);
    const snapshot = await startAudioRouteRuntime('inbound', fallbackConfig);
    setAudioRuntimeSnapshot(snapshot);
    if (!overlayWindow?.visible) {
      setRuntimeSnapshot(await showSubtitleOverlayWindow());
    }
    pushRuntimeNotification({
      id: `watch-fallback-${fallback}-${Date.now()}`,
      level: 'warning',
      source: 'session',
      message: subtitlesOnly
        ? '虚拟音频链路不可用，已降级为仅字幕模式。'
        : '虚拟音频链路不可用，已临时切换到物理扬声器直放加 AEC。该模式仍有回环风险。',
      emittedAt: new Date().toISOString(),
    });
  };

  const handleSceneLaunch = async (mode: SceneMode) => {
    const inboundVoiceModelId = configDraft.devices.inboundVoiceModelId;
    const { isOmniModel } = resolveVoiceModelRuntime(inboundVoiceModelId);
    const speechPatch = resolveSceneSpeechPatch(mode, configDraft, isOmniModel);
    const secondarySubtitleTranslationEnabled =
      configDraft.devices.subtitleTranslationMode === 'secondary' &&
      Boolean(configDraft.devices.subtitleTranslationModelId);

    const nextConfig = {
      ...configDraft,
      devices: {
        ...configDraft.devices,
        routeMode: mode,
        status: 'ready' as const,
      },
      speech: {
        ...configDraft.speech,
        ...speechPatch,
      },
    };

    try {
      await runBusyAction(mode === 'watch' ? 'watch-start' : 'conversation-start', async () => {
        await ensureBridgeReady(mode, nextConfig);

        updateDeviceDraft({ routeMode: mode, status: 'ready' });
        updateSpeechDraft(speechPatch);
        updateDiagnosticsDraft(mode === 'watch' ? { deviceStatus: 'ready' } : { deviceStatus: 'ready', driverStatus: 'ready' });

        let nextSnapshot = audioRuntimeSnapshot;

        if (mode !== 'voice-room') {
          nextSnapshot = await startAudioRouteRuntime('inbound', nextConfig);
          setAudioRuntimeSnapshot(nextSnapshot);
        }

        if (mode !== 'watch') {
          nextSnapshot = await startAudioRouteRuntime('outbound', nextConfig);
          setAudioRuntimeSnapshot(nextSnapshot);
        }

        if (!isOmniModel) {
          nextSnapshot = await startTranslateWorkerRuntime(nextConfig);
          setAudioRuntimeSnapshot(nextSnapshot);
        }

        const dispatchAlreadyRunning = nextSnapshot.speech.dispatchState !== 'idle';
        if (speechPatch.enabled && (!isOmniModel || secondarySubtitleTranslationEnabled) && !dispatchAlreadyRunning) {
          nextSnapshot = await startSpeechDispatchRuntime(nextConfig);
          setAudioRuntimeSnapshot(nextSnapshot);
        }

        if (!overlayWindow?.visible) {
          const windowSnapshot = await showSubtitleOverlayWindow();
          setRuntimeSnapshot(windowSnapshot);
        }
      });
    } catch (error) {
      if (mode === 'watch' && configDraft.devices.feedbackLoopPrevention === 'virtual-driver') {
        const subtitlesOnly = window.confirm(
          '虚拟音频驱动或 Bridge 尚不可用。点击“确定”进入仅字幕模式；点击“取消”临时回退到物理扬声器直放加 AEC。AEC 回退仍有回环风险。',
        );
        await startWatchFallback(subtitlesOnly ? 'subtitles-only' : 'aec');
        return;
      }
      pushRuntimeNotification({
        id: `scene-launch-${mode}-${Date.now()}`,
        level: 'error',
        source: 'session',
        message: `一键启动${resolveSceneLabel(mode)}失败：${error instanceof Error ? error.message : String(error)}`,
        emittedAt: new Date().toISOString(),
      });
    }
  };

  const handleStopAll = () => {
    const transcribe = hasSpeechActivity;
    const inboundBound = audioRuntimeSnapshot.inbound.streamBound;
    const outboundBound = audioRuntimeSnapshot.outbound.streamBound;

    // 乐观更新 UI，立刻显示为已停止
    setAudioRuntimeSnapshot({
      ...audioRuntimeSnapshot,
      inbound: { ...audioRuntimeSnapshot.inbound, streamBound: false, captureState: 'idle' },
      outbound: { ...audioRuntimeSnapshot.outbound, streamBound: false, captureState: 'idle' },
      speech: { ...audioRuntimeSnapshot.speech, dispatchState: 'idle' },
    });

    const stops: Promise<void>[] = [];

    if (transcribe) {
      stops.push(stopSpeechDispatchRuntime().then((s) => setAudioRuntimeSnapshot(s)));
    }

    stops.push(stopTranslateWorkerRuntime().then((s) => setAudioRuntimeSnapshot(s)));

    if (outboundBound) {
      stops.push(stopAudioRouteRuntime('outbound').then((s) => setAudioRuntimeSnapshot(s)));
    }

    if (inboundBound) {
      stops.push(stopAudioRouteRuntime('inbound').then((s) => setAudioRuntimeSnapshot(s)));
    }

    Promise.allSettled(stops).catch(console.error);
  };

  return (
    <div className="page-shell realtime-session-page">
      <section className="page-layout page-layout-single realtime-session-layout">
        <article className="content-card page-card compact-card control-hero-card">
          <PageSectionHeader
            className="control-hero-header"
            title="会话控制"
          />
          <div className="provider-list">
            <button className={configDraft.devices.routeMode === 'watch' ? 'action-button action-button-active' : 'action-button'} disabled={busyAction !== null} onClick={() => void handleSceneLaunch('watch')} type="button">
              {busyAction === 'watch-start' ? '启动中...' : '看片'}
            </button>
            <button className={configDraft.devices.routeMode === 'game' || configDraft.devices.routeMode === 'voice-room' ? 'action-button action-button-active' : 'action-button'} disabled={busyAction !== null} onClick={() => void handleSceneLaunch('game')} type="button">
              {busyAction === 'conversation-start' ? '启动中...' : '对话模式'}
            </button>
          </div>
          {isSessionRunning && (
            <div className="session-timer">
              <AppIcon name="clock" size={14} />
              <span className="session-timer-text">已运行 {formatElapsed(sessionElapsed)}</span>
            </div>
          )}
          {isSessionRunning && audioRuntimeSnapshot.inbound.streamBound && (
            <AudioLevelMeter
              energyDb={audioRuntimeSnapshot.inbound.lastEnergyDb}
              label="系统音频"
              vadState={audioRuntimeSnapshot.inbound.vadState}
            />
          )}
          {isSessionRunning && audioRuntimeSnapshot.outbound.streamBound && (
            <AudioLevelMeter
              energyDb={audioRuntimeSnapshot.outbound.lastEnergyDb}
              label="麦克风音频"
              vadState={audioRuntimeSnapshot.outbound.vadState}
            />
          )}
          {isSessionRunning && (
            <div className="audio-status-grid">
              <div className="audio-status-item">
                <span className="audio-status-label">翻译首字平均时间</span>
                <span className="audio-status-value">{formatLatencyMs(firstTranslationAverageMs)}</span>
              </div>
              <div className="audio-status-item">
                <span className="audio-status-label">最近首字耗时</span>
                <span className="audio-status-value">{formatLatencyMs(firstTranslationLastMs)}</span>
              </div>
              <div className="audio-status-item">
                <span className="audio-status-label">首字样本</span>
                <span className="audio-status-value">{firstTranslationSampleCount}</span>
              </div>
              {audioRuntimeSnapshot.inbound.streamBound && (
                <>
                  <div className="audio-status-item">
                    <span className="audio-status-label">采集状态</span>
                    <span className="audio-status-value">{audioRuntimeSnapshot.inbound.captureState}</span>
                  </div>
                  <div className="audio-status-item">
                    <span className="audio-status-label">缓冲状态</span>
                    <span className="audio-status-value">{audioRuntimeSnapshot.inbound.preBufferState}</span>
                  </div>
                  <div className="audio-status-item">
                    <span className="audio-status-label">采集帧数</span>
                    <span className="audio-status-value">{audioRuntimeSnapshot.inbound.framesCaptured.toLocaleString()}</span>
                  </div>
                  <div className="audio-status-item">
                    <span className="audio-status-label">语音分段</span>
                    <span className="audio-status-value">{audioRuntimeSnapshot.inbound.segmentCount}</span>
                  </div>
                </>
              )}
              {audioRuntimeSnapshot.outbound.streamBound && (
                <>
                  <div className="audio-status-item">
                    <span className="audio-status-label">采集状态</span>
                    <span className="audio-status-value">{audioRuntimeSnapshot.outbound.captureState}</span>
                  </div>
                  <div className="audio-status-item">
                    <span className="audio-status-label">缓冲状态</span>
                    <span className="audio-status-value">{audioRuntimeSnapshot.outbound.preBufferState}</span>
                  </div>
                  <div className="audio-status-item">
                    <span className="audio-status-label">采集帧数</span>
                    <span className="audio-status-value">{audioRuntimeSnapshot.outbound.framesCaptured.toLocaleString()}</span>
                  </div>
                  <div className="audio-status-item">
                    <span className="audio-status-label">语音分段</span>
                    <span className="audio-status-value">{audioRuntimeSnapshot.outbound.segmentCount}</span>
                  </div>
                </>
              )}
            </div>
          )}
          <div className="control-toolbar">
            <button className={`icon-button ${isSessionRunning ? 'icon-button-danger' : ''}`} disabled={busyAction !== null || !canStopAll} onClick={() => void handleStopAll()} type="button">
              <AppIcon name="stop" size={14} />
              {isSessionRunning ? `停止 (${formatElapsed(sessionElapsed)})` : '停止全部链路'}
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
              {overlayWindow?.visible ? '隐藏浮窗' : '显示浮窗'}
            </button>
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
              清空字幕
            </button>
          </div>
        </article>

        <article className="content-card page-card compact-card live-text-card">
          <div className="section-heading compact-heading">
            <h3>模型调用摘要</h3>
            <StatusBadge label={modelTraceSummary.failedCalls > 0 ? `失败 ${modelTraceSummary.failedCalls}` : '正常'} tone={modelTraceSummary.failedCalls > 0 ? 'warning' : 'ready'} />
          </div>
          {latestModelTraceCall ? (
            <div className="audio-status-grid">
              <div className="audio-status-item">
                <span className="audio-status-label">调用总数</span>
                <span className="audio-status-value">{modelTraceSummary.totalCalls.toLocaleString()}</span>
              </div>
              <div className="audio-status-item">
                <span className="audio-status-label">成功 / 失败</span>
                <span className="audio-status-value">
                  {modelTraceSummary.succeededCalls.toLocaleString()} / {modelTraceSummary.failedCalls.toLocaleString()}
                </span>
              </div>
              <div className="audio-status-item">
                <span className="audio-status-label">当前模型</span>
                <span className="audio-status-value">{latestModelTraceCall.model || '—'}</span>
              </div>
              <div className="audio-status-item">
                <span className="audio-status-label">最近耗时</span>
                <span className="audio-status-value">{latestModelTraceCall.elapsedMs == null ? latestModelTraceCall.status : `${latestModelTraceCall.elapsedMs} ms`}</span>
              </div>
              <div className="audio-status-item">
                <span className="audio-status-label">最近 Cue</span>
                <span className="audio-status-value">{latestModelTraceCall.cueId ?? '-'}</span>
              </div>
            </div>
          ) : (
            <div className="console-event-item">
              <div className="compact-info-head">
                <strong>暂无模型调用</strong>
                <StatusBadge label="空" tone="pending" />
              </div>
              <p>启动看片模式后，这里会显示最近模型调用摘要</p>
            </div>
          )}
          {modelTraceSummary.lastError && <p className="cue-queue-error">最近错误：{modelTraceSummary.lastError}</p>}
        </article>

        <article className="content-card page-card compact-card live-text-card">
          <div className="section-heading compact-heading">
            <h3>当前字幕</h3>
          </div>
          {activeCue ? (
            <div className="console-event-item live-text-card">
              <div className="live-text-head">
                <strong>{activeCue.committed ? '已翻译' : '翻译中...'}</strong>
                <StatusBadge label={`队列 ${audioRuntimeSnapshot.subtitleOverlay.queueDepth} 条`} tone={audioRuntimeSnapshot.subtitleOverlay.queueDepth > 0 ? 'warning' : 'ready'} />
              </div>
              <p className="live-text-source">{activeCueSourceText}</p>
              <p className="live-text-translation">{activeCue.translatedText || (activeCue.committed ? '翻译失败' : '正在调用 LLM 翻译...')}</p>
            </div>
          ) : (
            <div className="console-event-item">
              <div className="compact-info-head">
                <strong>无活动字幕</strong>
                <StatusBadge label="空" tone="pending" />
              </div>
              <p>启动场景后，实时字幕会显示在这里。</p>
            </div>
          )}
        </article>

        <article className="content-card page-card compact-card live-text-card">
          <div className="section-heading compact-heading">
            <h3>字幕队列</h3>
            {audioRuntimeSnapshot.subtitleOverlay.droppedCueCount > 0 && (
              <StatusBadge label={`丢弃 ${audioRuntimeSnapshot.subtitleOverlay.droppedCueCount} 条`} tone="warning" />
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
                  <p className="cue-queue-source">{cue.displaySourceText || cue.sourceText}</p>
                  {cue.translatedText && (
                    <p className={cue.translatedText.startsWith('[翻译失败]') ? 'cue-queue-error' : 'cue-queue-translation'}>
                      {cue.translatedText}
                    </p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="console-event-item console-event-item-empty">
              <div className="compact-info-head">
                <strong>暂无字幕事件</strong>
                <StatusBadge label="空" tone="pending" />
              </div>
              <p>语音检测到分段后将在此处显示。</p>
            </div>
          )}
        </article>
      </section>
    </div>
  );
}

export default RealTimeSessionPage;
