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
  launchAttemptId?: string;
  mode: SceneMode;
  configDraft: AppConfigDraft;
  audioSnapshot: AudioRuntimeSnapshot;
  overlayVisible: boolean;
  isOmniModel: boolean;
  speechPatch: Partial<AppConfigDraft['speech']> & { enabled: boolean };
  secondarySubtitleTranslationEnabled: boolean;
};

export function buildSceneLaunchPlan(input: Input): SceneLaunchPlan {
  const config: AppConfigDraft = {
    ...input.configDraft,
    devices: {
      ...input.configDraft.devices,
      ...(input.launchAttemptId ? {
        inboundRoute: {
          ...input.configDraft.devices.inboundRoute,
          routeId: `audio-route-inbound-${input.launchAttemptId}`,
        },
      } : {}),
      routeMode: input.mode,
      status: 'ready',
      ...(input.mode === 'watch' ? {
        feedbackLoopPrevention: 'none' as const,
        aecEnabled: false,
        outputSpeechEnabled: true,
        virtualMicOutputEnabled: false,
      } : {
        feedbackLoopPrevention: 'echo-cancel' as const,
        aecEnabled: true,
        outputSpeechEnabled: true,
        virtualMicOutputEnabled: false,
      }),
    },
    speech: {
      ...input.configDraft.speech,
      ...input.speechPatch,
      ...(input.mode === 'watch' ? { outputTarget: 'speaker' as const } : {}),
    },
  };
  // Watch capture does not depend on Bridge. Starting with bridge-ready lets an
  // unrelated bootstrap consume the entire launch deadline before native audio IPC.
  const stages: SceneLaunchStage[] = input.mode === 'watch' ? [] : ['bridge-ready'];
  // Omni route startup now returns as soon as its worker and audio queue exist.
  // The worker buffers captured audio until session.ready, so a separate blocking
  // preconnect would only delay the one-click path.
  const parallelOmniPreconnect = false;
  stages.push('inbound-route');
  if (input.mode !== 'watch') stages.push('outbound-route');
  if (!input.isOmniModel) stages.push('translate-worker');
  if (input.speechPatch.enabled
    && (!input.isOmniModel || input.secondarySubtitleTranslationEnabled)
    && input.audioSnapshot.speech.dispatchState === 'idle') stages.push('speech-dispatch');
  // Watch routes create the native overlay together with capture. Starting it
  // again from the renderer is both duplicate work and outside route rollback.
  if (input.mode !== 'watch' && !input.overlayVisible) stages.push('subtitle-overlay');
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
    // Watch plans never contain renderer-owned overlay startup, so speech is
    // always the last compensatable fallback stage.
    plan.stages.push('speech-dispatch');
  }
  return plan;
}
