import type { AudioRuntimeSnapshot } from '../../schema/audio-runtime';
import type { AppConfigDraft } from '../../schema/config';
import type { SceneMode } from '../../utils/scene-readiness';
import type { ResolvedRealtimeProfile } from '../../utils/realtime-profile';

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
  realtimeProfile: Pick<ResolvedRealtimeProfile, 'nativeTranslation' | 'speechDispatchPolicy'>;
  speechPatch: Partial<AppConfigDraft['speech']> & { enabled: boolean };
  secondarySubtitleTranslationEnabled: boolean;
};

export function buildSceneLaunchPlan(input: Input): SceneLaunchPlan {
  // Preserve the user's selected route exactly. Legacy `none` remains valid
  // for subtitles-only/diagnostic capture, while launch preflight explicitly
  // blocks it when translated speech would be played.
  const watchFeedbackLoopPrevention = input.configDraft.devices.feedbackLoopPrevention;
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
        feedbackLoopPrevention: watchFeedbackLoopPrevention,
        aecEnabled: watchFeedbackLoopPrevention === 'echo-cancel',
        outputSpeechEnabled: input.configDraft.devices.outputSpeechEnabled,
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
  // Every Watch launch converges the Bridge capture backend before binding the
  // source route. For process/driver routes this starts the selected backend;
  // for AEC/none it is a fast no-op unless a previously running Bridge must be
  // re-initialized to `none` so its old capture generation and translation
  // queue cannot leak across the mode switch.
  const stages: SceneLaunchStage[] = ['bridge-ready'];
  // Omni route startup now returns as soon as its worker and audio queue exist.
  // The worker buffers captured audio until session.ready, so a separate blocking
  // preconnect would only delay the one-click path.
  const parallelOmniPreconnect = false;
  stages.push('inbound-route');
  if (input.mode !== 'watch') stages.push('outbound-route');
  if (!input.realtimeProfile.nativeTranslation) stages.push('translate-worker');
  if (input.speechPatch.enabled
    && (!input.realtimeProfile.nativeTranslation || input.secondarySubtitleTranslationEnabled)
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
