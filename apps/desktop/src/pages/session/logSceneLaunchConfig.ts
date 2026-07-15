import type { AudioRuntimeSnapshot } from '../../schema/audio-runtime';
import type { AppConfigDraft } from '../../schema/config';
import type { RuntimeSnapshot } from '../../schema/runtime-core';
import { appendFrontendDiagnosticsLog } from '../../runtime/diagnostics-runtime';
import type { SceneMode } from '../../utils/scene-readiness';
import i18n from '../../i18n/config';
import { stringifyRedacted } from '../../utils/redact-sensitive-data';

function resolveSceneLabel(mode: SceneMode) {
  return mode === 'watch' ? i18n.t('session.watchMode') : i18n.t('session.conversationMode');
}

export function logSceneLaunchConfig(
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
    lines.push(stringifyRedacted(configDraft));
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
