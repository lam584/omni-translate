import type { AudioRuntimeSnapshot } from '../../schema/audio-runtime';
import type { AppConfigDraft } from '../../schema/config';
import type { SceneMode } from '../../utils/scene-readiness';

export type SceneLaunchStage =
  | 'bridge-ready'
  | 'omni-preconnect'
  | 'inbound-route'
  | 'outbound-route'
  | 'translate-worker'
  | 'speech-dispatch'
  | 'subtitle-overlay';

export type SceneLaunchPlan = {
  mode: SceneMode;
  config: AppConfigDraft;
  stages: SceneLaunchStage[];
  parallelOmniPreconnect: boolean;
};

type Input = {
  mode: SceneMode;
  configDraft: AppConfigDraft;
  audioSnapshot: AudioRuntimeSnapshot;
  overlayVisible: boolean;
  isOmniModel: boolean;
  speechPatch: Partial<AppConfigDraft['speech']> & { enabled: boolean };
  secondarySubtitleTranslationEnabled: boolean;
};

export function buildSceneLaunchPlan(input: Input): SceneLaunchPlan {
  const useEchoCancel = input.mode !== 'watch';
  const config: AppConfigDraft = {
    ...input.configDraft,
    devices: {
      ...input.configDraft.devices,
      routeMode: input.mode,
      status: 'ready',
      ...(useEchoCancel ? {
        feedbackLoopPrevention: 'echo-cancel' as const,
        aecEnabled: true,
        outputSpeechEnabled: true,
        virtualMicOutputEnabled: false,
      } : {}),
    },
    speech: { ...input.configDraft.speech, ...input.speechPatch },
  };
  const stages: SceneLaunchStage[] = ['bridge-ready'];
  const parallelOmniPreconnect = input.mode === 'watch' && input.isOmniModel;
  if (parallelOmniPreconnect) stages.push('omni-preconnect');
  if (input.mode !== 'voice-room') stages.push('inbound-route');
  if (input.mode !== 'watch') stages.push('outbound-route');
  if (!input.isOmniModel) stages.push('translate-worker');
  if (input.speechPatch.enabled
    && (!input.isOmniModel || input.secondarySubtitleTranslationEnabled)
    && input.audioSnapshot.speech.dispatchState === 'idle') stages.push('speech-dispatch');
  if (!input.overlayVisible) stages.push('subtitle-overlay');
  return {
    mode: input.mode,
    config,
    stages,
    parallelOmniPreconnect,
  };
}

export function buildWatchFallbackPlan(
  input: Omit<Input, 'mode' | 'speechPatch'> & { speechPatch: Input['speechPatch'] },
): SceneLaunchPlan {
  const plan = buildSceneLaunchPlan({ ...input, mode: 'watch' });
  plan.parallelOmniPreconnect = false;
  plan.stages = plan.stages.filter((stage) => stage !== 'omni-preconnect');
  if (input.speechPatch.enabled && !plan.stages.includes('speech-dispatch')) {
    const overlayIndex = plan.stages.indexOf('subtitle-overlay');
    plan.stages.splice(overlayIndex < 0 ? plan.stages.length : overlayIndex, 0, 'speech-dispatch');
  }
  return plan;
}
