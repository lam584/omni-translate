import type { StatusTone } from '../components/page/StatusBadge';
import i18n from '../i18n/config';
import type { AudioRuntimeSnapshot } from '../schema/audio-runtime';
import type { AppConfigDraft } from '../schema/config';
import type { RuntimeSnapshot } from '../schema/runtime-core';
import { resolveRuntimeBridgeStatus } from '../runtime/runtime-status';

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

  return checkedAt.length > 0 && checkedAt !== i18n.t('providerProbe.pendingProbe') && !profileId.endsWith('-pending');
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
    configDraft.devices.virtualMicOutputEnabled ||
    configDraft.speech?.outputTarget === 'virtual-mic' ||
    configDraft.speech?.outputTarget === 'both'
  );
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

  if (watchModeNeedsBridge(configDraft) && runtimeSnapshot.bridge.bridgeState !== 'running') {
    blockers.push({ id: 'watch-bridge', title: i18n.t('sceneReadiness.virtualDriverPending'), route: '/audio-routing' });
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

  if (configDraft.devices.feedbackLoopPrevention !== 'echo-cancel' || !configDraft.devices.aecEnabled) {
    blockers.push({ id: 'game-aec', title: i18n.t('sceneReadiness.aecPending'), route: '/audio-routing' });
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

  if (configDraft.devices.feedbackLoopPrevention !== 'echo-cancel' || !configDraft.devices.aecEnabled) {
    blockers.push({ id: 'voice-room-aec', title: i18n.t('sceneReadiness.aecPending'), route: '/audio-routing' });
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
