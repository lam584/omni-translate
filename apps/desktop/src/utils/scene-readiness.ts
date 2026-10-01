import type { StatusTone } from '../components/page/StatusBadge';
import i18n from '../i18n/config';
import type { AudioRuntimeSnapshot } from '../schema/audio-runtime';
import type { AppConfigDraft } from '../schema/config';
import type { RuntimeSnapshot } from '../schema/runtime-core';
import type { ScenarioMode } from '../schema/scenario';
import { resolveRuntimeBridgeStatus } from '../runtime/runtime-status';
import { isPendingProbeCheckedAt } from './provider-probe';
import { isProcessLoopbackReady, resolveProcessLoopbackCapability } from './process-loopback-capability';
import { resolveAecCapability } from './aec-capability';
import { resolveVirtualDriverCapability, type VirtualDriverCapability } from './virtual-driver-capability';
import { authorizedCustomDashScopeRealtime } from './custom-dashscope-authority';
import { resolveRealtimeProfile } from './realtime-profile';

export type SceneMode = ScenarioMode;

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

export function isOverlayVisible(runtimeSnapshot: RuntimeSnapshot) {
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

function modelProtocolBlockers(config: AppConfigDraft, mode: SceneMode): SceneBlocker[] {
  const voiceModels = mode === "voice-room"
    ? [config.devices.inboundVoiceModelId, config.devices.outboundVoiceModelId]
    : [config.devices.inboundVoiceModelId];
  const requested: Array<{ reference: string; text: boolean; role: "primary-audio" | "primary-text" | "secondary-subtitle" }> =
    [...new Set(voiceModels)].map((reference) => ({ reference, text: false, role: "primary-audio" }));

  const blockers: SceneBlocker[] = [];

  // Check if primary voice model is ASR / text-worker that requires primary text translation
  for (const voiceRef of voiceModels) {
    if (!voiceRef) continue;
    try {
      const profile = resolveRealtimeProfile(config, voiceRef) as unknown as {
        nativeTranslation?: boolean;
        translationExecution?: "dedicated-realtime" | "prompted-realtime" | "text-worker";
        invocationOperation?: "native_translate" | "dialogue" | "asr";
      };
      const needsTextWorker = profile.translationExecution === "text-worker"
        || (profile.translationExecution === undefined && !profile.nativeTranslation);
      if (needsTextWorker) {
        const textRef = config.devices.primaryTextTranslationModelId;
        if (textRef) {
          requested.push({ reference: textRef, text: true, role: "primary-text" });
        } else {
          blockers.push({
            id: mode + "-primary-text-missing",
            title: i18n.t("audioRouting.primaryTextModelRequired") || "当前语音模型需要选择基础文本翻译模型",
            route: "/audio-routing",
          });
        }
      }
    } catch {
      // Audio protocol resolution error handled below
    }
  }

  // The secondary worker is opt-in. A retained selection is irrelevant in native mode.
  if (config.devices.subtitleTranslationMode === "secondary" && config.devices.subtitleTranslationModelId) {
    requested.push({ reference: config.devices.subtitleTranslationModelId, text: true, role: "secondary-subtitle" });
  }
  for (const item of requested) {
    const [templateId, modelId] = item.reference.includes("::")
      ? item.reference.split("::", 2)
      : ["", item.reference];
    const provider = templateId
      ? config.providers.find((entry) => entry.templateId === templateId)
      : config.providers.find((entry) => entry.model === modelId || entry.candidateModelGroups?.some((group) => group.modelIds.includes(modelId)));
    if (!provider) {
      if (item.reference) {
        const roleLabel = item.role === "primary-text"
          ? (i18n.t("session.modelRole.primary-text") || "基础文本翻译模型")
          : item.role === "secondary-subtitle"
          ? (i18n.t("session.modelRole.secondary-subtitle") || "二次字幕模型")
          : (i18n.t("session.modelRole.primary-audio") || "主音频模型");
        blockers.push({
          id: mode + "-" + item.role + "-unresolved-" + (modelId || "empty"),
          title: roleLabel + " " + (modelId || "（未选择）") + " 未关联到启用的平台",
          route: "/providers",
        });
      }
      continue;
    }
    // Built-in candidate metadata is advisory too; it must not make an
    // unregistered or manifest-only DashScope model appear ready to start.
    if (!item.text && provider.kind === "dashscope" && provider.templateSource !== "custom") {
      try {
        resolveRealtimeProfile(config, item.reference);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        blockers.push({
          id: mode + "-audio-protocol-" + (modelId || "empty"),
          title: "主音频模型 " + (modelId || "（未选择）") + " 的实时协议不可用：" + reason,
          route: "/providers",
        });
      }
      continue;
    }
    if (item.text && provider.templateSource !== "custom") {
      const textGroup = provider.candidateModelGroups?.find((g) => g.group === "text-processing");
      const hasTextModel = textGroup ? textGroup.modelIds.includes(modelId) : (provider.model === modelId || provider.candidateModelGroups?.some((g) => g.modelIds.includes(modelId)));
      if (!hasTextModel) {
        const roleLabel = item.role === "primary-text"
          ? (i18n.t("session.modelRole.primary-text") || "基础文本翻译模型")
          : (i18n.t("session.modelRole.secondary-subtitle") || "二次字幕模型");
        blockers.push({
          id: mode + "-text-protocol-" + (modelId || "empty"),
          title: roleLabel + " " + (modelId || "（未选择）") + " 缺少文本翻译能力支持",
          route: "/providers",
        });
      }
      continue;
    }
    if (provider.templateSource !== "custom") continue;
    const matching = (provider.modelProtocolBindings ?? []).filter((binding) => binding.modelId === modelId
      && (item.text ? binding.operation === "text-translation" : (binding.operation.startsWith("realtime-") || binding.operation === "asr" || binding.operation === "realtime-transcription")));
    if (modelId && (matching.length === 1
      || (!item.text && matching.length === 0 && authorizedCustomDashScopeRealtime(provider, modelId)))) continue;
    const roleLabel = item.role === "primary-text"
      ? (i18n.t("session.modelRole.primary-text") || "基础文本翻译模型")
      : item.role === "secondary-subtitle"
      ? (i18n.t("session.modelRole.secondary-subtitle") || "二次字幕模型")
      : (i18n.t("session.modelRole.primary-audio") || "主音频模型");
    const protocolKind = item.text ? "text" : "audio";
    blockers.push({
      id: mode + "-" + protocolKind + "-protocol-" + (modelId || "empty"),
      title: item.text ? (roleLabel + " " + (modelId || "（未选择）") + " 缺少文本翻译协议绑定")
        : (roleLabel + " " + (modelId || "（未选择）") + " 缺少实时协议绑定"),
      route: "/providers",
    });
  }
  const active = config.providers.find((entry) => entry.templateId === config.activeProviderTemplateId);
  if (active?.templateSource === "custom" && !active.model.trim()
    && !(active.candidateModelGroups ?? []).some((group) => group.modelIds.length)) {
    blockers.push({ id: mode + "-empty-custom-platform", title: "自定义平台尚未添加模型", route: "/providers" });
  }
  return blockers;
}
export function getWatchSceneReadiness(
  configDraft: AppConfigDraft,
  runtimeSnapshot: RuntimeSnapshot,
  audioRuntimeSnapshot: AudioRuntimeSnapshot,
): SceneReadiness {
  const blockers: SceneBlocker[] = modelProtocolBlockers(configDraft, 'watch');

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
  const blockers: SceneBlocker[] = modelProtocolBlockers(configDraft, 'game');
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
  const blockers: SceneBlocker[] = modelProtocolBlockers(configDraft, 'voice-room');
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
