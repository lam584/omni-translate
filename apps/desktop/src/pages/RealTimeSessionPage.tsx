import { useState, useEffect, useRef } from 'react';
import AppIcon from '../components/icons/AppIcon';
import { useTranslation } from 'react-i18next';
import AudioLevelMeter from '../components/audio/AudioLevelMeter';
import PageSectionHeader from '../components/page/PageSectionHeader';
import StatusBadge from '../components/page/StatusBadge';
import {
  clearSubtitleCuesRuntime,
  showSubtitleOverlayWindow,
  startAudioRouteRuntime,
  preconnectOmniRealtimeRuntime,
  startSpeechDispatchRuntime,
  startTranslateWorkerRuntime,
  stopAudioRouteRuntime,
  stopSpeechDispatchRuntime,
  stopTranslateWorkerRuntime,
  toggleSubtitleOverlayWindow,
} from '../runtime/audio-runtime';
import { installDriverRuntime, refreshBridgeRuntime, repairDriverRuntime, startBridgeServiceRuntime } from '../runtime/bridge-runtime';
import { appendFrontendDiagnosticsLog } from '../runtime/diagnostics-runtime';
import { useAppStore } from '../stores/app-store';
import type { SubtitleCueRuntime } from '../schema/audio-runtime';
import type { AppConfigDraft } from '../schema/config';
import type { SceneMode } from '../utils/scene-readiness';
import { watchModeNeedsBridge } from '../utils/scene-readiness';
import type { RuntimeSnapshot } from '../schema/runtime-core';
import type { AudioRuntimeSnapshot } from '../schema/audio-runtime';
import i18n from '../i18n/config';

type BusyAction = 'watch-start' | 'conversation-start' | 'overlay' | 'clear-cues' | 'stop' | null;

const TRANSLATION_FAILED_PREFIX = '[\u7ffb\u8bd1\u5931\u8d25]';

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

function isBridgeStartupError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const lower = message.toLowerCase();
  return (
    lower.includes('bridge') ||
    lower.includes('driver') ||
    lower.includes('source pipe') ||
    lower.includes('virtual') ||
    lower.includes('sysvad') ||
    lower.includes('package') ||
    lower.includes('wasapi')
  );
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

function logSceneLaunchConfig(
  mode: SceneMode,
  configDraft: AppConfigDraft,
  runtimeSnapshot: RuntimeSnapshot,
  audioRuntimeSnapshot: AudioRuntimeSnapshot,
  extra?: { speechPatch?: Record<string, unknown>; isOmniModel?: boolean; secondarySubtitleTranslationEnabled?: boolean },
) {
  const label = resolveSceneLabel(mode);
  const timestamp = new Date().toISOString();
  const devices = configDraft.devices;
  const subtitles = configDraft.subtitles;
  const speech = configDraft.speech;
  const driver = configDraft.driver;
  const glossary = configDraft.glossary;
  const diagnostics = configDraft.diagnostics;
  const bridge = runtimeSnapshot.bridge;

  const lines: string[] = [];

  const formatValue = (v: unknown): string => {
    if (v === null || v === undefined) return '(not set)';
    if (typeof v === 'object') {
      try { return JSON.stringify(v); } catch { return String(v); }
    }
    return String(v);
  };

  const section = (title: string) => {
    lines.push('');
    lines.push(`== ${title} ==`);
  };

  const log = (key: string, value: unknown) => {
    lines.push(`  ${key}: ${formatValue(value)}`);
  };

  // ---- Scene and model selection ----
  section('Scene information');
  log('scene mode (mode)', mode);
  log('scene label', label);
  log('is Omni model', extra?.isOmniModel ?? false);
  log('secondary subtitle translation enabled', extra?.secondarySubtitleTranslationEnabled ?? false);
  log('launch time', timestamp);

  // ---- Provider configuration ----
  section(`Provider configuration (activeTemplateId: ${configDraft.activeProviderTemplateId}, ${configDraft.providers.length} total)`);
  configDraft.providers.forEach((provider, index) => {
    lines.push('');
    lines.push(`  -- Provider[${index}]: ${provider.displayName || provider.providerId} --`);
    log('templateId', provider.templateId);
    log('templateVersion', provider.templateVersion);
    log('providerId', provider.providerId);
    log('kind', provider.kind);
    log('mode', provider.mode);
    log('model', provider.model);
    log('baseUrl', provider.baseUrl);
    log('transport', provider.transport);
    log('region', provider.region ?? '(not set)');
    log('streamEnabled', provider.streamEnabled);
    log('timeoutMs', provider.timeoutMs);
    log('temperature', provider.temperature);
    log('maxOutputTokens', provider.maxOutputTokens);
    log('responseModalities', provider.responseModalities);
    log('authRef.kind', provider.authRef.kind);
    log('authRef.reference', provider.authRef.reference);
    log('authRef.scheme', provider.authRef.scheme);
    log('authRef.headerName', provider.authRef.headerName);
    log('customHeaders', provider.customHeaders.length > 0 ? provider.customHeaders.map((h) => `${h.name}=${h.enabled ? 'enabled' : 'disabled'}`) : '(none)');
    log('sceneModelAssignments', provider.sceneModelAssignments.map((a) => `${a.scenario}: [${a.modelIds.join(', ')}]`));
    log('probe.verdict', provider.probe.verdict);
    log('probe.profileId', provider.probe.profileId);
    log('probe.checkedAt', provider.probe.checkedAt);
    log('probe.streamSupported', provider.probe.streamSupported);
    log('probe.errorShapeStable', provider.probe.errorShapeStable);
    log('probe.responseShapeStable', provider.probe.responseShapeStable);
    log('status', provider.status);
  });

  // ---- Device and audio routing configuration ----
  section('Device configuration (devices)');
  log('routeMode', devices.routeMode);
  log('inputDeviceId', devices.inputDeviceId || '(default)');
  log('outputDeviceId', devices.outputDeviceId || '(default)');
  log('virtualRenderDeviceId', devices.virtualRenderDeviceId || '(not set)');
  log('playbackDeviceId', devices.playbackDeviceId || '(default)');
  log('virtualMicState', devices.virtualMicState);
  log('supportProfileId', devices.supportProfileId || '(not set)');
  log('inboundVoiceModelId', devices.inboundVoiceModelId || '(not set)');
  log('outboundVoiceModelId', devices.outboundVoiceModelId || '(not set)');
  log('textToSpeechModelId', devices.textToSpeechModelId || '(not set)');
  log('subtitleTranslationMode', devices.subtitleTranslationMode);
  log('subtitleTranslationModelId', devices.subtitleTranslationModelId || '(not set)');
  log('inputLevel', devices.inputLevel);
  log('aecEnabled', devices.aecEnabled);
  log('ansEnabled', devices.ansEnabled);
  log('agcEnabled', devices.agcEnabled);
  log('outputLevel', devices.outputLevel);
  log('outputSpeechEnabled', devices.outputSpeechEnabled);
  log('outputSubtitlesEnabled', devices.outputSubtitlesEnabled);
  log('virtualMicOutputEnabled', devices.virtualMicOutputEnabled);
  log('feedbackLoopPrevention', devices.feedbackLoopPrevention);
  log('status', devices.status);

  section('Inbound Route');
  log('routeId', devices.inboundRoute.routeId);
  log('direction', devices.inboundRoute.direction);
  log('input.sourceId', devices.inboundRoute.input.sourceId);
  log('input.kind', devices.inboundRoute.input.kind);
  log('input.deviceId', devices.inboundRoute.input.deviceId);
  log('input.state', devices.inboundRoute.input.state);
  log('input.muted', devices.inboundRoute.input.muted);
  log('input.bufferAheadMs', devices.inboundRoute.input.bufferAheadMs);
  log('input.preBufferState', devices.inboundRoute.input.preBufferState);
  log('input.processing', devices.inboundRoute.input.processing);
  log('outputs', devices.inboundRoute.outputs.map((o) => `${o.targetId}(${o.kind}, enabled=${o.enabled})`));
  log('mixControl', devices.inboundRoute.mixControl);
  log('latencyControl', devices.inboundRoute.latencyControl);

  section('Outbound Route');
  log('routeId', devices.outboundRoute.routeId);
  log('direction', devices.outboundRoute.direction);
  log('input.sourceId', devices.outboundRoute.input.sourceId);
  log('input.kind', devices.outboundRoute.input.kind);
  log('input.deviceId', devices.outboundRoute.input.deviceId);
  log('input.state', devices.outboundRoute.input.state);
  log('input.muted', devices.outboundRoute.input.muted);
  log('input.bufferAheadMs', devices.outboundRoute.input.bufferAheadMs);
  log('input.preBufferState', devices.outboundRoute.input.preBufferState);
  log('input.processing', devices.outboundRoute.input.processing);
  log('outputs', devices.outboundRoute.outputs.map((o) => `${o.targetId}(${o.kind}, enabled=${o.enabled})`));
  log('mixControl', devices.outboundRoute.mixControl);
  log('latencyControl', devices.outboundRoute.latencyControl);
  log('pushToTalk', devices.outboundRoute.pushToTalk ?? '(not set)');

  // ---- Subtitle configuration ----
  section('Subtitle configuration (subtitles)');
  log('sourceLanguage', subtitles.sourceLanguage);
  log('targetLanguage', subtitles.targetLanguage);
  log('translationLanguagePreference', subtitles.translationLanguagePreference);
  log('mode', subtitles.mode);
  log('captionDensity', subtitles.captionDensity);
  log('priority', subtitles.priority);
  log('instructions', subtitles.instructions || '(empty)');
  log('overlayOpacity', subtitles.overlayOpacity);
  log('overlayLocked', subtitles.overlayLocked);
  log('overlayTextColor', subtitles.overlayTextColor);
  log('overlayTextOpacity', subtitles.overlayTextOpacity);
  log('overlayBackgroundColor', subtitles.overlayBackgroundColor);
  log('overlayBackgroundOpacity', subtitles.overlayBackgroundOpacity);
  log('overlayFontFamily', subtitles.overlayFontFamily);
  log('overlayFontSize', subtitles.overlayFontSize);
  log('overlayWidth', subtitles.overlayWidth);
  log('overlayHeight', subtitles.overlayHeight);
  log('overlayX', subtitles.overlayX);
  log('overlayY', subtitles.overlayY);
  log('status', subtitles.status);

  // ---- Speech/TTS configuration ----
  section('Speech configuration (speech)');
  if (speech) {
    log('enabled', speech.enabled);
    log('targetLanguage', speech.targetLanguage);
    log('voicePresetId', speech.voicePresetId || '(not set)');
    log('textToSpeechModelId', speech.textToSpeechModelId || '(not set)');
    log('voice', speech.voice || '(not set)');
    log('outputTarget', speech.outputTarget);
    log('localPlaybackEnabled', speech.localPlaybackEnabled);
    log('virtualMicOutputEnabled', speech.virtualMicOutputEnabled);
    log('translationAudioSource', speech.translationAudioSource);
    log('dispatchState', speech.dispatchState);
    log('status', speech.status);
  } else {
    lines.push('  (speech configuration undefined)');
  }
  if (extra?.speechPatch) {
    log('current speechPatch', extra.speechPatch);
  }

  // ---- Driver and Bridge state ----
  section('Driver configuration (driver)');
  log('protocolVersion', driver.protocolVersion);
  log('installChannel', driver.installChannel);
  log('installPhase', driver.installPhase);
  log('targetDeviceId', driver.targetDeviceId || '(not set)');
  log('expectedDriverVersion', driver.expectedDriverVersion || '(not set)');
  log('expectedBridgeVersion', driver.expectedBridgeVersion || '(not set)');
  log('bridgeState', driver.bridgeState);
  log('driverHealth', driver.driverHealth);
  log('rollbackSupported', driver.rollbackSupported);
  log('lastErrorCode', driver.lastErrorCode ?? '(none)');
  log('recommendedAction', driver.recommendedAction ?? '(none)');
  log('status', driver.status);

  section('Bridge runtime state');
  log('processStatus', bridge.processStatus);
  log('bridgeState', bridge.bridgeState);
  log('lifecycleState', bridge.lifecycleState);
  log('driverHealth', bridge.driverHealth);
  log('driverVersion', bridge.driverVersion ?? '(unknown)');
  log('bridgeVersion', bridge.bridgeVersion);
  log('installChannel', bridge.installChannel);
  log('installPhase', bridge.installPhase);
  log('captureBackend', bridge.captureBackend);
  log('captureLifecycleState', bridge.captureLifecycleState);
  log('targetDeviceId', bridge.targetDeviceId);
  log('virtualRenderDeviceId', bridge.virtualRenderDeviceId);
  log('physicalPlaybackDeviceId', bridge.physicalPlaybackDeviceId);
  log('resolvedPhysicalPlaybackDeviceId', bridge.resolvedPhysicalPlaybackDeviceId);
  log('mixControl', bridge.mixControl);
  log('monitorPlaybackEnabled', bridge.monitorPlaybackEnabled);
  log('pipeName', bridge.pipeName);
  log('sessionId', bridge.sessionId ?? '(none)');
  log('lastHandshakeAt', bridge.lastHandshakeAt ?? '(none)');
  log('lastErrorCode', bridge.lastErrorCode ?? '(none)');
  log('recommendedAction', bridge.recommendedAction ?? '(none)');
  log('rollbackSupported', bridge.rollbackSupported);
  log('testSigningEnabled', bridge.testSigningEnabled);
  log('signatureEnforcementBypassed', bridge.signatureEnforcementBypassed);
  log('memoryIntegrityEnabled', bridge.memoryIntegrityEnabled);
  log('secureBootEnabled', bridge.secureBootEnabled);
  log('ioctlAvailable', bridge.ioctlAvailable);
  log('endpointName', bridge.endpointName ?? '(none)');
  log('abiVersion', bridge.abiVersion ?? '(none)');

  // ---- Glossary configuration ----
  section('Glossary configuration (glossary)');
  log('templateId', glossary.templateId || '(not set)');
  log('scenario', glossary.scenario);
  log('injectionStrategy', glossary.injectionStrategy);
  log('injectionOrder', glossary.injectionOrder);
  log('processingMode', glossary.processingMode);
  log('calibrationModelId', glossary.calibrationModelId || '(not set)');
  log('importStrategy', glossary.importStrategy);
  log('libraries count', glossary.libraries.length);
  log('activePackageIds', glossary.activePackageIds);
  log('communityPackageIds', glossary.communityPackageIds);
  log('status', glossary.status);

  // ---- Diagnostics configuration ----
  section('Diagnostics configuration (diagnostics)');
  log('installStatus', diagnostics.installStatus);
  log('driverStatus', diagnostics.driverStatus);
  log('providerStatus', diagnostics.providerStatus);
  log('deviceStatus', diagnostics.deviceStatus);
  log('lastExportScope', diagnostics.lastExportScope);
  log('supportTier', diagnostics.supportTier);
  log('status', diagnostics.status);

  // ---- Current audio runtime ----
  section('Audio runtime snapshot');
  log('status', audioRuntimeSnapshot.status);
  log('host', audioRuntimeSnapshot.host);
  log('sttConnected', audioRuntimeSnapshot.sttConnected);
  log('sttBufferSize', audioRuntimeSnapshot.sttBufferSize);
  log('sessionStartedAt', audioRuntimeSnapshot.sessionStartedAt ?? '(not started)');
  log('renderDevices', audioRuntimeSnapshot.renderDevices.map((d) => `${d.label} (${d.deviceId}, default=${d.isDefault}, state=${d.state})`));
  log('captureDevices', audioRuntimeSnapshot.captureDevices.map((d) => `${d.label} (${d.deviceId}, default=${d.isDefault}, state=${d.state})`));
  log('inbound.streamBound', audioRuntimeSnapshot.inbound.streamBound);
  log('inbound.captureState', audioRuntimeSnapshot.inbound.captureState);
  log('inbound.requestedDeviceId', audioRuntimeSnapshot.inbound.requestedDeviceId);
  log('inbound.effectiveDeviceId', audioRuntimeSnapshot.inbound.effectiveDeviceId);
  log('outbound.streamBound', audioRuntimeSnapshot.outbound.streamBound);
  log('outbound.captureState', audioRuntimeSnapshot.outbound.captureState);
  log('outbound.requestedDeviceId', audioRuntimeSnapshot.outbound.requestedDeviceId);
  log('outbound.effectiveDeviceId', audioRuntimeSnapshot.outbound.effectiveDeviceId);
  log('speech.dispatchState', audioRuntimeSnapshot.speech.dispatchState);
  log('speech.outputTarget', audioRuntimeSnapshot.speech.outputTarget);
  log('subtitleOverlay.queueDepth', audioRuntimeSnapshot.subtitleOverlay.queueDepth);

  // ---- Full configuration JSON backup ----
  section('Full configuration (JSON)');
  try {
    lines.push(JSON.stringify(configDraft, null, 2));
  } catch {
    lines.push('(serialization failed)');
  }

  const detail = lines.join('\n');
  appendFrontendDiagnosticsLog(
    'runtime',
    'info',
    `[SceneLaunch] ${label} launch config @ ${timestamp}`,
    detail,
  );
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
      queueMicrotask(() => setSessionElapsed(0));
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
      if (!watchModeNeedsBridge(nextConfig)) {
        return runtimeSnapshot;
      }
    }

    // Refresh live bridge state from the backend instead of relying on the
    // cached snapshot, which may be stale (e.g. bridge crashed after last
    // refresh but the frontend still thinks it is "running").
    let latestRuntime: RuntimeSnapshot;
    try {
      latestRuntime = await refreshBridgeRuntime();
      setRuntimeSnapshot(latestRuntime);
    } catch (refreshError) {
      // If refresh itself fails (e.g. timeout), the bridge is likely in a
      // bad state — fall through to repair/restart logic using cached state.
      appendFrontendDiagnosticsLog(
        'runtime',
        'warning',
        `[BridgeReady] refresh failed, proceeding with cached snapshot: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`,
      );
      latestRuntime = runtimeSnapshot;
    }

    if (latestRuntime.bridge.driverHealth === 'not-installed') {
      const installed = await installDriverRuntime(nextConfig);
      setRuntimeSnapshot(installed);
      return installed;
    }

    if (latestRuntime.bridge.driverHealth !== 'running') {
      const recommended = latestRuntime.bridge.recommendedAction;
      const repairAction = recommended === 'rollback-driver'
        ? 'rollback-driver' as const
        : recommended === 'restart-bridge'
          ? 'restart-bridge' as const
          : 'reinstall-driver' as const;

      const repaired = await repairDriverRuntime(repairAction, nextConfig);
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

  const startWatchFallback = async (fallback: 'subtitles-only' | 'aec', originalError?: unknown) => {
    const originalErrorMessage = originalError instanceof Error ? originalError.message : originalError == null ? '' : String(originalError);
    const fallbackDetail = [
      `fallback type: ${fallback}`,
      `original error: ${originalErrorMessage || '(none)'}`,
      `current bridge state: ${runtimeSnapshot.bridge.bridgeState} | driverHealth: ${runtimeSnapshot.bridge.driverHealth}`,
      '',
      '== Current configDraft ==',
      (() => { try { return JSON.stringify(configDraft, null, 2); } catch { return '(serialization failed)'; } })(),
      '',
      '== Current audioRuntimeSnapshot ==',
      (() => { try { return JSON.stringify(audioRuntimeSnapshot, null, 2); } catch { return '(serialization failed)'; } })(),
    ].join('\n');
    appendFrontendDiagnosticsLog(
      'runtime',
      'warning',
      `[WatchFallback] fallback strategy: ${fallback} @ ${new Date().toISOString()}`,
      fallbackDetail,
    );

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
      message: `${subtitlesOnly ? t('session.fallbackSubtitlesOnly') : t('session.fallbackAec')}${originalErrorMessage ? `（原始错误：${originalErrorMessage}）` : ''}`,
      emittedAt: new Date().toISOString(),
    });
  };

  const handleSceneLaunch = async (mode: SceneMode) => {
    if (
      mode === 'watch' &&
      (audioRuntimeSnapshot.inbound.captureState === 'stopping' ||
        audioRuntimeSnapshot.outbound.captureState === 'stopping')
    ) {
      pushRuntimeNotification({
        id: `scene-launch-stopping-${Date.now()}`,
        level: 'warning',
        source: 'session',
        message: '正在停止上一条链路，请稍后再启动看片模式。',
        emittedAt: new Date().toISOString(),
      });
      return;
    }

    const inboundVoiceModelId = configDraft.devices.inboundVoiceModelId;
    const { isOmniModel } = resolveVoiceModelRuntime(inboundVoiceModelId);
    const speechPatch = resolveSceneSpeechPatch(mode, configDraft, isOmniModel);
    const secondarySubtitleTranslationEnabled =
      configDraft.devices.subtitleTranslationMode === 'secondary' &&
      Boolean(configDraft.devices.subtitleTranslationModelId);

    // Log the full configuration before launch for diagnostics.
    logSceneLaunchConfig(mode, configDraft, runtimeSnapshot, audioRuntimeSnapshot, {
      speechPatch,
      isOmniModel,
      secondarySubtitleTranslationEnabled,
    });

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

    let preconnectWarningMessage: string | null = null;
    let launchStage: string | null = null;

    try {
      await runBusyAction(mode === 'watch' ? 'watch-start' : 'conversation-start', async () => {
        if (mode === 'watch' && isOmniModel) {
          // Parallelize preconnect + bridge: they are independent operations.
          // preconnect opens a WebSocket to DashScope, bridge starts the local
          // bridge service/driver. Running them concurrently saves ~300-1000ms.
          const bridgePromise = ensureBridgeReady(mode, nextConfig);
          let preconnectPromise: Promise<AudioRuntimeSnapshot> | null = null;
          try {
            launchStage = 'omni-preconnect';
            preconnectPromise = preconnectOmniRealtimeRuntime(nextConfig);
          } catch (error) {
            preconnectWarningMessage = `Omni 预连接失败，已改走普通启动路径：${error instanceof Error ? error.message : String(error)}`;
            appendFrontendDiagnosticsLog(
              'runtime',
              'warning',
              `[WatchPreconnect] Omni preconnect failed; retrying through the normal launch path: ${error instanceof Error ? error.message : String(error)}`,
            );
          }

          // Await bridge completion (mandatory path).
          launchStage = 'bridge-ready';
          await bridgePromise;

          // Await preconnect completion (best-effort; failure is non-fatal).
          if (preconnectPromise) {
            try {
              const preconnected = await preconnectPromise;
              setAudioRuntimeSnapshot(preconnected);
            } catch (error) {
              preconnectWarningMessage = `Omni 预连接失败，已改走普通启动路径：${error instanceof Error ? error.message : String(error)}`;
              appendFrontendDiagnosticsLog(
                'runtime',
                'warning',
                `[WatchPreconnect] Omni preconnect failed; retrying through the normal launch path: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        } else {
          launchStage = 'bridge-ready';
          await ensureBridgeReady(mode, nextConfig);
        }

        updateDeviceDraft({ routeMode: mode, status: 'ready' });
        updateSpeechDraft(speechPatch);
        updateDiagnosticsDraft(mode === 'watch' ? { deviceStatus: 'ready' } : { deviceStatus: 'ready', driverStatus: 'ready' });

        let nextSnapshot = audioRuntimeSnapshot;

        if (mode !== 'voice-room') {
          launchStage = 'inbound-route';
          nextSnapshot = await startAudioRouteRuntime('inbound', nextConfig);
          setAudioRuntimeSnapshot(nextSnapshot);
        }

        if (mode !== 'watch') {
          launchStage = 'outbound-route';
          nextSnapshot = await startAudioRouteRuntime('outbound', nextConfig);
          setAudioRuntimeSnapshot(nextSnapshot);
        }

        if (!isOmniModel) {
          launchStage = 'translate-worker';
          nextSnapshot = await startTranslateWorkerRuntime(nextConfig);
          setAudioRuntimeSnapshot(nextSnapshot);
        }

        const dispatchAlreadyRunning = nextSnapshot.speech.dispatchState !== 'idle';
        if (speechPatch.enabled && (!isOmniModel || secondarySubtitleTranslationEnabled) && !dispatchAlreadyRunning) {
          launchStage = 'speech-dispatch';
          nextSnapshot = await startSpeechDispatchRuntime(nextConfig);
          setAudioRuntimeSnapshot(nextSnapshot);
        }

        if (!overlayWindow?.visible) {
          try {
            launchStage = 'subtitle-overlay';
            const windowSnapshot = await showSubtitleOverlayWindow();
            setRuntimeSnapshot(windowSnapshot);
          } catch (overlayError) {
            appendFrontendDiagnosticsLog(
              'runtime',
              'error',
              `[SceneLaunch] subtitle overlay failed after route start: ${overlayError instanceof Error ? overlayError.message : String(overlayError)}`,
            );
            if (mode === 'watch') {
              try {
                const stopped = await stopAudioRouteRuntime('inbound');
                setAudioRuntimeSnapshot(stopped);
              } catch (stopError) {
                appendFrontendDiagnosticsLog(
                  'runtime',
                  'error',
                  `[SceneLaunch] failed to stop inbound route after overlay failure: ${stopError instanceof Error ? stopError.message : String(stopError)}`,
                );
              }
            }
            pushRuntimeNotification({
              id: `scene-overlay-${mode}-${Date.now()}`,
              level: 'error',
              source: 'session',
              message:
                mode === 'watch'
                  ? `字幕浮窗打开失败，已停止看片采集：${overlayError instanceof Error ? overlayError.message : String(overlayError)}`
                  : `字幕浮窗打开失败：${overlayError instanceof Error ? overlayError.message : String(overlayError)}`,
              emittedAt: new Date().toISOString(),
            });
          }
        }
        if (preconnectWarningMessage) {
          pushRuntimeNotification({
            id: `watch-preconnect-${Date.now()}`,
            level: 'warning',
            source: 'session',
            message: preconnectWarningMessage,
            emittedAt: new Date().toISOString(),
          });
        }
      });
    } catch (error) {
      if (mode === 'watch' && watchModeNeedsBridge(nextConfig) && isBridgeStartupError(error)) {
        const subtitlesOnly = window.confirm(
          t('session.virtualDriverFallbackConfirm'),
        );
        await startWatchFallback(subtitlesOnly ? 'subtitles-only' : 'aec', error);
        return;
      }
      pushRuntimeNotification({
        id: `scene-launch-${mode}-${Date.now()}`,
        level: 'error',
        source: 'session',
        message: t('session.sceneLaunchFailed', {
          scene: resolveSceneLabel(mode),
          stage: describeSceneLaunchStage(launchStage),
          error: error instanceof Error ? error.message : String(error),
        }),
        emittedAt: new Date().toISOString(),
      });
    }
  };

  const handleStopAll = async () => {
    const transcribe = hasSpeechActivity;
    const inboundBound = audioRuntimeSnapshot.inbound.streamBound;
    const outboundBound = audioRuntimeSnapshot.outbound.streamBound;

    await runBusyAction('stop', async () => {
      setAudioRuntimeSnapshot({
        ...audioRuntimeSnapshot,
        inbound: inboundBound
          ? { ...audioRuntimeSnapshot.inbound, streamBound: false, captureState: 'stopping' }
          : audioRuntimeSnapshot.inbound,
        outbound: outboundBound
          ? { ...audioRuntimeSnapshot.outbound, streamBound: false, captureState: 'stopping' }
          : audioRuntimeSnapshot.outbound,
        speech: { ...audioRuntimeSnapshot.speech, dispatchState: transcribe ? 'idle' : audioRuntimeSnapshot.speech.dispatchState },
      });

      const stopStep = async (label: string, action: () => Promise<AudioRuntimeSnapshot>) => {
        try {
          setAudioRuntimeSnapshot(await action());
        } catch (error) {
          appendFrontendDiagnosticsLog(
            'runtime',
            'error',
            `[StopAll] ${label} stop failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          pushRuntimeNotification({
            id: `stop-${label}-${Date.now()}`,
            level: 'error',
            source: 'session',
            message: `停止 ${label} 失败：${error instanceof Error ? error.message : String(error)}`,
            emittedAt: new Date().toISOString(),
          });
        }
      };

      if (transcribe) {
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

  return (
    <div className="page-shell realtime-session-page">
      <section className="page-layout page-layout-single realtime-session-layout">
        <article className="content-card page-card compact-card control-hero-card">
          <PageSectionHeader
            className="control-hero-header"
            title={t('session.controlTitle')}
          />
          <div className="provider-list">
            <button className={configDraft.devices.routeMode === 'watch' ? 'action-button action-button-active' : 'action-button'} disabled={busyAction !== null} onClick={() => void handleSceneLaunch('watch')} type="button">
              {busyAction === 'watch-start' ? t('session.starting') : t('session.watchButton')}
            </button>
            <button className={configDraft.devices.routeMode === 'game' || configDraft.devices.routeMode === 'voice-room' ? 'action-button action-button-active' : 'action-button'} disabled={busyAction !== null} onClick={() => void handleSceneLaunch('game')} type="button">
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
          {isSessionRunning && (
            <div className="audio-status-grid">
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
              {audioRuntimeSnapshot.inbound.streamBound && (
                <>
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
                </>
              )}
              {audioRuntimeSnapshot.outbound.streamBound && (
                <>
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
                </>
              )}
            </div>
          )}
          {audioRuntimeSnapshot.inbound.lastError && (
            <p className="cue-queue-error" role="alert">
              {t('session.systemAudioError', { error: audioRuntimeSnapshot.inbound.lastError })}
              {audioRuntimeSnapshot.inbound.recommendedAction === 'restart-bridge' && t('session.restartBridgeHint')}
            </p>
          )}
          <div className="control-toolbar">
            <button className={`icon-button ${isSessionRunning ? 'icon-button-danger' : ''}`} disabled={busyAction !== null || !canStopAll} onClick={() => void handleStopAll()} type="button">
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
              <p className="live-text-source">{activeCueSourceText}</p>
              <p className="live-text-translation">{activeCue.translatedText || (activeCue.committed ? t('session.translationFailed') : t('session.callingLlm'))}</p>
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
                  <p className="cue-queue-source">{cue.displaySourceText || cue.sourceText}</p>
                  {cue.translatedText && (
                    <p className={cue.translatedText.startsWith(TRANSLATION_FAILED_PREFIX) ? 'cue-queue-error' : 'cue-queue-translation'}>
                      {cue.translatedText}
                    </p>
                  )}
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
