import type { StatusTone } from '../components/page/StatusBadge';
import type { AudioRuntimeSnapshot } from '../schema/audio-runtime';
import type { AppConfigDraft, ProviderDraft } from '../schema/config';
import type { RuntimeSnapshot } from '../schema/runtime-core';
import { resolveRuntimeBridgeStatus } from '../runtime/runtime-status';
import { resolveRealtimeAudioMode } from './provider-model-capabilities';

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

  return checkedAt.length > 0 && checkedAt !== '待重新探测' && !profileId.endsWith('-pending');
}

function getRuntimeBlocker(mode: SceneMode, runtimeSnapshot: RuntimeSnapshot): SceneBlocker | null {
  const runtimeStatus = resolveRuntimeBridgeStatus(runtimeSnapshot);

  if (runtimeStatus === 'browser-preview') {
    return {
      id: `${mode}-runtime-preview`,
      title: '当前仍在浏览器预览模式，桥接、采集和字幕浮窗状态需在桌面壳确认',
      route: '/diagnostics',
    };
  }

  if (runtimeStatus === 'runtime-error') {
    return {
      id: `${mode}-runtime-error`,
      title: '桌面运行时还没接通，当前不能确认桥接、采集和字幕浮窗状态',
      route: '/diagnostics',
    };
  }

  return null;
}

function hasVirtualMicOutputConfigured(configDraft: AppConfigDraft) {
  return (
    configDraft.speech.enabled &&
    configDraft.speech.virtualMicOutputEnabled &&
    (configDraft.speech.outputTarget === 'virtual-mic' || configDraft.speech.outputTarget === 'both')
  );
}

export function watchModeNeedsBridge(configDraft: AppConfigDraft) {
  return (
    configDraft.devices.feedbackLoopPrevention === 'virtual-driver' ||
    configDraft.devices.virtualMicOutputEnabled ||
    configDraft.speech?.outputTarget === 'virtual-mic' ||
    configDraft.speech?.outputTarget === 'both'
  );
}

function resolveProviderForModel(configDraft: AppConfigDraft, compositeModelId: string): { provider: ProviderDraft; modelId: string } | null {
  const [templateId, explicitModelId] = compositeModelId.includes('::') ? compositeModelId.split('::') : ['', compositeModelId];
  if (templateId && explicitModelId) {
    const provider = configDraft.providers.find((item) => item.templateId === templateId);
    return provider ? { provider, modelId: explicitModelId } : null;
  }

  for (const provider of configDraft.providers) {
    if (provider.model === compositeModelId) {
      return { provider, modelId: compositeModelId };
    }
    if (provider.sceneModelAssignments.some((assignment) => assignment.modelIds.includes(compositeModelId))) {
      return { provider, modelId: compositeModelId };
    }
  }

  return null;
}

function getWatchRealtimeModeBlocker(configDraft: AppConfigDraft): SceneBlocker | null {
  const modelId = configDraft.devices.inboundVoiceModelId;
  if (!modelId.trim()) {
    return null;
  }

  const resolved = resolveProviderForModel(configDraft, modelId);
  if (!resolved) {
    return null;
  }

  const mode = resolveRealtimeAudioMode(resolved.modelId, resolved.provider.localModelCapabilityRegistry ?? [], resolved.modelId);
  void mode;

  return null;
}

export function getWatchSceneReadiness(
  configDraft: AppConfigDraft,
  runtimeSnapshot: RuntimeSnapshot,
  audioRuntimeSnapshot: AudioRuntimeSnapshot,
): SceneReadiness {
  const blockers: SceneBlocker[] = [];

  if (!hasProviderVerificationAttempt(configDraft)) {
    blockers.push({ id: 'watch-provider', title: '模型待完成验证', route: '/providers' });
  }

  const realtimeModeBlocker = getWatchRealtimeModeBlocker(configDraft);
  if (realtimeModeBlocker) {
    blockers.push(realtimeModeBlocker);
  }

  const runtimeBlocker = getRuntimeBlocker('watch', runtimeSnapshot);
  if (runtimeBlocker) {
    blockers.push(runtimeBlocker);

    return {
      mode: 'watch',
      label: '看片模式',
      description: '模型、系统音频、字幕浮窗都能用即可开始。',
      readyLabel: '可直接开始',
      blockers,
    };
  }

  if (watchModeNeedsBridge(configDraft) && runtimeSnapshot.bridge.bridgeState !== 'running') {
    blockers.push({ id: 'watch-bridge', title: '虚拟音频驱动待启动（译音输出需要）', route: '/audio-routing' });
  }

  if (!audioRuntimeSnapshot.inbound.streamBound) {
    blockers.push({ id: 'watch-inbound', title: '系统音频待启动采集', route: '/audio-routing' });
  }

  if (!isOverlayVisible(runtimeSnapshot)) {
    blockers.push({ id: 'watch-overlay', title: '字幕浮窗待显示', route: '/session' });
  }

  return {
    mode: 'watch',
    label: '看片模式',
    description: '模型、系统音频、字幕浮窗都能用即可开始。',
    readyLabel: '可直接开始',
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
    blockers.push({ id: 'game-provider', title: '模型待完成验证', route: '/providers' });
  }

  const runtimeBlocker = getRuntimeBlocker('game', runtimeSnapshot);
  if (runtimeBlocker) {
    blockers.push(runtimeBlocker);

    return {
      mode: 'game',
      label: '游戏语音模式',
      description: '双向采集、译音输出和虚拟麦克风都收口即可开始。',
      readyLabel: '可直接开始',
      blockers,
    };
  }

  if (runtimeSnapshot.bridge.bridgeState !== 'running') {
    blockers.push({ id: 'game-bridge', title: '桥接链路待启动', route: '/audio-routing' });
  }

  if (!audioRuntimeSnapshot.inbound.streamBound) {
    blockers.push({ id: 'game-inbound', title: '入站系统音频待启动采集', route: '/audio-routing' });
  }

  if (!audioRuntimeSnapshot.outbound.streamBound) {
    blockers.push({ id: 'game-outbound', title: '出站麦克风待启动采集', route: '/audio-routing' });
  }

  if (!hasVirtualMicOutputConfigured(configDraft)) {
    blockers.push({ id: 'game-speech', title: '译音输出待切到虚拟麦克风', route: '/audio-routing' });
  }

  return {
    mode: 'game',
    label: '游戏语音模式',
    description: '双向采集、译音输出和虚拟麦克风都收口即可开始。',
    readyLabel: '可直接开始',
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
    blockers.push({ id: 'voice-room-provider', title: '模型待完成验证', route: '/providers' });
  }

  const runtimeBlocker = getRuntimeBlocker('voice-room', runtimeSnapshot);
  if (runtimeBlocker) {
    blockers.push(runtimeBlocker);

    return {
      mode: 'voice-room',
      label: '语音房模式',
      description: '桥接、麦克风和虚拟麦克风输出都收口即可开始。',
      readyLabel: '可直接开始',
      blockers,
    };
  }

  if (runtimeSnapshot.bridge.bridgeState !== 'running') {
    blockers.push({ id: 'voice-room-bridge', title: '桥接链路待启动', route: '/audio-routing' });
  }

  if (!audioRuntimeSnapshot.outbound.streamBound) {
    blockers.push({ id: 'voice-room-outbound', title: '麦克风待启动采集', route: '/audio-routing' });
  }

  if (!hasVirtualMicOutputConfigured(configDraft)) {
    blockers.push({ id: 'voice-room-speech', title: '译音输出待切到虚拟麦克风', route: '/audio-routing' });
  }

  return {
    mode: 'voice-room',
    label: '语音房模式',
    description: '桥接、麦克风和虚拟麦克风输出都收口即可开始。',
    readyLabel: '可直接开始',
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

  return `待收口 ${blockerCount} 项`;
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
    label: `${readyCount}/${totalCount} 场景就绪`,
  };
}
