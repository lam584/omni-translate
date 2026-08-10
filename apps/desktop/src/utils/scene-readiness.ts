import type { StatusTone } from '../components/page/StatusBadge';
import i18n from '../i18n/config';
import type { AudioRuntimeSnapshot } from '../schema/audio-runtime';
import type { AppConfigDraft } from '../schema/config';
import type { RuntimeSnapshot } from '../schema/runtime-core';
import { resolveRuntimeBridgeStatus } from '../runtime/runtime-status';
import { isPendingProbeCheckedAt } from './provider-probe';
import { isProcessLoopbackReady, resolveProcessLoopbackCapability } from './process-loopback-capability';
import { resolveAecCapability } from './aec-capability';
import { resolveVirtualDriverCapability, type VirtualDriverCapability } from './virtual-driver-capability';

export type SceneMode = 'watch' | 'game' | 'voice-room';

export type SceneBlocker = {
  id: string;
  title: string;
  route: string;
};

export type SceneReadiness = {
  mode: SceneMode;
  label: string;
  description: string;
  readyLabel: string;
  blockers: SceneBlocker[];
};

function isOverlayVisible(runtimeSnapshot: RuntimeSnapshot) {
  return runtimeSnapshot.windows.find((item) => item.label === 'subtitle-overlay')?.visible === true;
}

function hasProviderVerificationAttempt(configDraft: AppConfigDraft) {
  const activeProvider = configDraft.providers.find((p) => p.templateId === configDraft.activeProviderTemplateId);
  if (!activeProvider) return false;
  const checkedAt = activeProvider.probe.checkedAt.trim();
  const profileId = activeProvider.probe.profileId.trim();

  return checkedAt.length > 0 && !isPendingProbeCheckedAt(checkedAt) && !profileId.endsWith('-pending');
}

function getRuntimeBlocker(mode: SceneMode, runtimeSnapshot: RuntimeSnapshot): SceneBlocker | null {
  const runtimeStatus = resolveRuntimeBridgeStatus(runtimeSnapshot);

  if (runtimeStatus === 'browser-preview') {
    return {
      id: `${mode}-runtime-preview`,
      title: i18n.t('sceneReadiness.browserPreviewBlocker'),
      route: '/diagnostics',
    };
  }

  if (runtimeStatus === 'runtime-error') {
    return {
      id: `${mode}-runtime-error`,
      title: i18n.t('sceneReadiness.runtimeErrorBlocker'),
      route: '/diagnostics',
    };
  }

  return null;
}

export function watchModeNeedsBridge(configDraft: AppConfigDraft) {
  return (
    configDraft.devices.feedbackLoopPrevention === 'virtual-driver' ||
    configDraft.devices.feedbackLoopPrevention === 'process-exclusion' ||
    configDraft.devices.virtualMicOutputEnabled ||
    configDraft.speech?.outputTarget === 'virtual-mic' ||
    configDraft.speech?.outputTarget === 'both'
  );
}

function virtualMicOutputRequested(configDraft: AppConfigDraft) {
  return configDraft.devices.virtualMicOutputEnabled
    || configDraft.speech?.outputTarget === 'virtual-mic'
    || configDraft.speech?.outputTarget === 'both';
}

function virtualMicUnavailableTitle(capability: VirtualDriverCapability) {
  if (!capability.windowsBuildSupported) {
    return `${i18n.t('audioRouting.unsupportedVirtualMicSpeech')} (Windows build ${capability.minimumWindowsBuild}+)`;
  }
  return i18n.t('audioRouting.unsupportedVirtualMicSpeech');
}

export function getWatchSceneReadiness(
  configDraft: AppConfigDraft,
  runtimeSnapshot: RuntimeSnapshot,
  audioRuntimeSnapshot: AudioRuntimeSnapshot,
): SceneReadiness {
  const blockers: SceneBlocker[] = [];

  if (!hasProviderVerificationAttempt(configDraft)) {
    blockers.push({ id: 'watch-provider', title: i18n.t('sceneReadiness.providerNotVerified'), route: '/providers' });
  }

  const runtimeBlocker = getRuntimeBlocker('watch', runtimeSnapshot);
  if (runtimeBlocker) {
    blockers.push(runtimeBlocker);

    return {
      mode: 'watch',
      label: i18n.t('sceneReadiness.watchLabel'),
      description: i18n.t('sceneReadiness.watchDescription'),
      readyLabel: i18n.t('sceneReadiness.readyToStart'),
      blockers,
    };
  }

  const processExclusionSelected = configDraft.devices.feedbackLoopPrevention === 'process-exclusion';
  const virtualDriverSelected = configDraft.devices.feedbackLoopPrevention === 'virtual-driver';
  const processLoopback = resolveProcessLoopbackCapability(runtimeSnapshot.bridge);
  const virtualDriver = resolveVirtualDriverCapability(runtimeSnapshot.bridge);
  const aecCapability = resolveAecCapability(audioRuntimeSnapshot);
  const translatedSpeechWithoutFeedbackRoute = configDraft.devices.feedbackLoopPrevention === 'none'
    && Boolean(configDraft.devices.outputSpeechEnabled || configDraft.speech?.enabled);
  const processLoopbackUnavailable = processExclusionSelected
    && ['unsupported', 'failed'].includes(processLoopback.status);
  const virtualDriverUnsupported = virtualDriverSelected && !virtualDriver.windowsBuildSupported;

  if (translatedSpeechWithoutFeedbackRoute) {
    blockers.push({ id: 'watch-feedback-route-required', title: i18n.t('sceneReadiness.feedbackRouteRequired'), route: '/audio-routing' });
  } else if (configDraft.devices.feedbackLoopPrevention === 'echo-cancel' && !aecCapability.ready) {
    blockers.push({ id: 'watch-aec-unavailable', title: i18n.t('sceneReadiness.aecUnavailable'), route: '/audio-routing' });
  } else if (processLoopbackUnavailable) {
    const title = processLoopback.status === 'failed'
      ? i18n.t('sceneReadiness.processExclusionFailed', {
        detail: processLoopback.failureDetail ?? i18n.t('sceneReadiness.processExclusionUnknownDetail'),
      })
      : i18n.t('sceneReadiness.processExclusionUnsupported', {
        build: processLoopback.windowsBuildNumber ?? i18n.t('sceneReadiness.processExclusionUnknownBuild'),
        minimum: processLoopback.minimumWindowsBuild,
      });
    blockers.push({ id: `watch-process-exclusion-${processLoopback.status}`, title, route: '/audio-routing' });
  } else if (virtualDriverUnsupported) {
    blockers.push({
      id: 'watch-virtual-driver-unsupported',
      title: virtualMicUnavailableTitle(virtualDriver),
      route: '/audio-routing',
    });
  } else if (watchModeNeedsBridge(configDraft) && runtimeSnapshot.bridge.bridgeState !== 'running') {
    blockers.push({
      id: 'watch-bridge',
      title: processExclusionSelected
        ? i18n.t('sceneReadiness.processExclusionBridgePending')
        : i18n.t('sceneReadiness.virtualDriverPending'),
      route: '/audio-routing',
    });
  } else if (processExclusionSelected && !isProcessLoopbackReady(processLoopback)) {
    blockers.push({
      id: `watch-process-exclusion-${processLoopback.status}`,
      title: i18n.t('sceneReadiness.processExclusionProbing'),
      route: '/audio-routing',
    });
  } else if (virtualMicOutputRequested(configDraft) && !virtualDriver.virtualMicOutputReady) {
    blockers.push({
      id: `watch-virtual-mic-output-${runtimeSnapshot.bridge.virtualMicOutputStatus}`,
      title: virtualMicUnavailableTitle(virtualDriver),
      route: '/audio-routing',
    });
  }

  if (!audioRuntimeSnapshot.inbound.streamBound) {
    blockers.push({ id: 'watch-inbound', title: i18n.t('sceneReadiness.systemAudioPending'), route: '/audio-routing' });
  }

  if (!isOverlayVisible(runtimeSnapshot)) {
    blockers.push({ id: 'watch-overlay', title: i18n.t('sceneReadiness.overlayPending'), route: '/session' });
  }

  return {
    mode: 'watch',
    label: i18n.t('sceneReadiness.watchLabel'),
    description: i18n.t('sceneReadiness.watchDescription'),
    readyLabel: i18n.t('sceneReadiness.readyToStart'),
    blockers,
  };
}

export function getGameSceneReadiness(
  configDraft: AppConfigDraft,
  runtimeSnapshot: RuntimeSnapshot,
  audioRuntimeSnapshot: AudioRuntimeSnapshot,
): SceneReadiness {
  const blockers: SceneBlocker[] = [];
  const aecCapability = resolveAecCapability(audioRuntimeSnapshot);
  const virtualDriver = resolveVirtualDriverCapability(runtimeSnapshot.bridge);
  const virtualDriverSelected = configDraft.devices.feedbackLoopPrevention === 'virtual-driver';
  const isolatedOutboundUnavailable = configDraft.devices.feedbackLoopPrevention === 'process-exclusion'
    || (virtualDriverSelected && !virtualDriver.virtualMicOutputReady);

  if (!hasProviderVerificationAttempt(configDraft)) {
    blockers.push({ id: 'game-provider', title: i18n.t('sceneReadiness.providerNotVerified'), route: '/providers' });
  }

  const runtimeBlocker = getRuntimeBlocker('game', runtimeSnapshot);
  if (runtimeBlocker) {
    blockers.push(runtimeBlocker);

    return {
      mode: 'game',
      label: i18n.t('sceneReadiness.gameLabel'),
      description: i18n.t('sceneReadiness.gameDescription'),
      readyLabel: i18n.t('sceneReadiness.readyToStart'),
      blockers,
    };
  }

  if (!audioRuntimeSnapshot.inbound.streamBound) {
    blockers.push({ id: 'game-inbound', title: i18n.t('sceneReadiness.inboundAudioPending'), route: '/audio-routing' });
  }

  if (!audioRuntimeSnapshot.outbound.streamBound) {
    blockers.push({ id: 'game-outbound', title: i18n.t('sceneReadiness.outboundMicPending'), route: '/audio-routing' });
  }

  if (isolatedOutboundUnavailable) {
    blockers.push({
      id: 'game-virtual-mic-output-unavailable',
      title: virtualMicUnavailableTitle(virtualDriver),
      route: '/audio-routing',
    });
  } else if (!virtualDriverSelected && (configDraft.devices.feedbackLoopPrevention !== 'echo-cancel' || !aecCapability.ready)) {
    blockers.push({
      id: 'game-aec',
      title: aecCapability.ready ? i18n.t('sceneReadiness.aecPending') : i18n.t('sceneReadiness.aecUnavailable'),
      route: '/audio-routing',
    });
  }

  return {
    mode: 'game',
    label: i18n.t('sceneReadiness.gameLabel'),
    description: i18n.t('sceneReadiness.gameDescription'),
    readyLabel: i18n.t('sceneReadiness.readyToStart'),
    blockers,
  };
}

export function getVoiceRoomSceneReadiness(
  configDraft: AppConfigDraft,
  runtimeSnapshot: RuntimeSnapshot,
  audioRuntimeSnapshot: AudioRuntimeSnapshot,
): SceneReadiness {
  const blockers: SceneBlocker[] = [];
  const aecCapability = resolveAecCapability(audioRuntimeSnapshot);
  const virtualDriver = resolveVirtualDriverCapability(runtimeSnapshot.bridge);
  const virtualDriverSelected = configDraft.devices.feedbackLoopPrevention === 'virtual-driver';
  const isolatedOutboundUnavailable = configDraft.devices.feedbackLoopPrevention === 'process-exclusion'
    || (virtualDriverSelected && !virtualDriver.virtualMicOutputReady);

  if (!hasProviderVerificationAttempt(configDraft)) {
    blockers.push({ id: 'voice-room-provider', title: i18n.t('sceneReadiness.providerNotVerified'), route: '/providers' });
  }

  const runtimeBlocker = getRuntimeBlocker('voice-room', runtimeSnapshot);
  if (runtimeBlocker) {
    blockers.push(runtimeBlocker);

    return {
      mode: 'voice-room',
      label: i18n.t('sceneReadiness.voiceRoomLabel'),
      description: i18n.t('sceneReadiness.voiceRoomDescription'),
      readyLabel: i18n.t('sceneReadiness.readyToStart'),
      blockers,
    };
  }

  if (!audioRuntimeSnapshot.outbound.streamBound) {
    blockers.push({ id: 'voice-room-outbound', title: i18n.t('sceneReadiness.micPending'), route: '/audio-routing' });
  }

  if (isolatedOutboundUnavailable) {
    blockers.push({
      id: 'voice-room-virtual-mic-output-unavailable',
      title: virtualMicUnavailableTitle(virtualDriver),
      route: '/audio-routing',
    });
  } else if (!virtualDriverSelected && (configDraft.devices.feedbackLoopPrevention !== 'echo-cancel' || !aecCapability.ready)) {
    blockers.push({
      id: 'voice-room-aec',
      title: aecCapability.ready ? i18n.t('sceneReadiness.aecPending') : i18n.t('sceneReadiness.aecUnavailable'),
      route: '/audio-routing',
    });
  }

  return {
    mode: 'voice-room',
    label: i18n.t('sceneReadiness.voiceRoomLabel'),
    description: i18n.t('sceneReadiness.voiceRoomDescription'),
    readyLabel: i18n.t('sceneReadiness.readyToStart'),
    blockers,
  };
}

export function getAllSceneReadiness(
  configDraft: AppConfigDraft,
  runtimeSnapshot: RuntimeSnapshot,
  audioRuntimeSnapshot: AudioRuntimeSnapshot,
): SceneReadiness[] {
  return [
    getWatchSceneReadiness(configDraft, runtimeSnapshot, audioRuntimeSnapshot),
    getGameSceneReadiness(configDraft, runtimeSnapshot, audioRuntimeSnapshot),
    getVoiceRoomSceneReadiness(configDraft, runtimeSnapshot, audioRuntimeSnapshot),
  ];
}

export function formatSceneReadinessLabel(blockerCount: number, readyLabel: string) {
  if (blockerCount === 0) {
    return readyLabel;
  }

  return i18n.t('sceneReadiness.blockerCount', { count: blockerCount });
}

export function getSceneTone(blockerCount: number): StatusTone {
  if (blockerCount === 0) {
    return 'ready';
  }

  if (blockerCount <= 2) {
    return 'draft';
  }

  return 'warning';
}

export type OverallReadiness = {
  readyCount: number;
  totalCount: number;
  tone: StatusTone;
  label: string;
};

export function getOverallReadiness(scenes: SceneReadiness[]): OverallReadiness {
  const readyCount = scenes.filter((scene) => scene.blockers.length === 0).length;
  const totalCount = scenes.length;
  const tone: StatusTone = readyCount === totalCount ? 'ready' : readyCount > 0 ? 'warning' : 'risk';

  return {
    readyCount,
    totalCount,
    tone,
    label: i18n.t('sceneReadiness.overallLabel', { ready: readyCount, total: totalCount }),
  };
}
