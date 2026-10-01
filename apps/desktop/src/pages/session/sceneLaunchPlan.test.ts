import { describe, expect, it } from 'vitest';
import { appConfigDraftMock } from '../../mocks/app-config';
import { audioRuntimeSnapshotMock } from '../../mocks/audio-runtime';
import { buildSceneLaunchPlan, buildWatchFallbackPlan } from './sceneLaunchPlan';

describe('buildSceneLaunchPlan', () => {
  const nativeProfile = { nativeTranslation: true, speechDispatchPolicy: 'native-audio' as const };
  const classicProfile = { nativeTranslation: false, speechDispatchPolicy: 'subtitle-tts' as const };
  const cases = [
    { name: 'watch omni', mode: 'watch' as const, omni: true, secondary: false,
      stages: ['bridge-ready', 'inbound-route'] },
    { name: 'watch classic with speech', mode: 'watch' as const, omni: false, secondary: false,
      stages: ['bridge-ready', 'inbound-route', 'translate-worker', 'speech-dispatch'] },
    { name: 'game', mode: 'game' as const, omni: false, secondary: false,
      stages: ['bridge-ready', 'inbound-route', 'outbound-route', 'translate-worker', 'speech-dispatch', 'subtitle-overlay'] },
    { name: 'voice room', mode: 'voice-room' as const, omni: false, secondary: false,
      stages: ['bridge-ready', 'inbound-route', 'outbound-route', 'translate-worker', 'speech-dispatch', 'subtitle-overlay'] },
  ];
  for (const testCase of cases) {
    it(testCase.name, () => {
      const plan = buildSceneLaunchPlan({
        mode: testCase.mode,
        configDraft: structuredClone(appConfigDraftMock),
        audioSnapshot: {
          ...structuredClone(audioRuntimeSnapshotMock),
          speech: { ...structuredClone(audioRuntimeSnapshotMock.speech), dispatchState: 'idle' },
        },
        overlayVisible: false,
        realtimeProfile: testCase.omni ? nativeProfile : classicProfile,
        speechPatch: { enabled: true },
        secondarySubtitleTranslationEnabled: testCase.secondary,
      });
      expect(plan.stages).toEqual(testCase.stages);
      expect(plan.config.devices.routeMode).toBe(testCase.mode);
      if (testCase.mode === 'watch') {
        expect(plan.config.devices).toMatchObject({
          feedbackLoopPrevention: 'echo-cancel',
          aecEnabled: true,
          virtualMicOutputEnabled: false,
        });
        expect(plan.config.speech.outputTarget).toBe('speaker');
      }
    });
  }

  it('builds complete non-Omni subtitles-only and Omni AEC fallback plans', () => {
    const base = {
      configDraft: structuredClone(appConfigDraftMock),
      audioSnapshot: structuredClone(audioRuntimeSnapshotMock),
      overlayVisible: false,
      secondarySubtitleTranslationEnabled: false,
    };
    expect(buildWatchFallbackPlan({ ...base, realtimeProfile: classicProfile, speechPatch: { enabled: false } }).stages)
      .toEqual(['bridge-ready', 'inbound-route', 'translate-worker']);
    expect(buildWatchFallbackPlan({ ...base, realtimeProfile: nativeProfile, speechPatch: { enabled: true } }).stages)
      .toEqual(['bridge-ready', 'inbound-route', 'speech-dispatch']);
  });

  it('preserves virtual-driver isolation instead of enabling acoustic echo cancellation', () => {
    const configDraft = structuredClone(appConfigDraftMock);
    configDraft.devices.feedbackLoopPrevention = 'virtual-driver';
    configDraft.devices.aecEnabled = true;

    const plan = buildSceneLaunchPlan({
      mode: 'watch',
      configDraft,
      audioSnapshot: structuredClone(audioRuntimeSnapshotMock),
      overlayVisible: false,
      realtimeProfile: nativeProfile,
      speechPatch: { enabled: true },
      secondarySubtitleTranslationEnabled: false,
    });

    expect(plan.config.devices.feedbackLoopPrevention).toBe('virtual-driver');
    expect(plan.config.devices.aecEnabled).toBe(false);
  });

  it('preserves process-exclusion isolation instead of enabling acoustic echo cancellation', () => {
    const configDraft = structuredClone(appConfigDraftMock);
    configDraft.devices.feedbackLoopPrevention = 'process-exclusion';
    configDraft.devices.aecEnabled = true;

    const plan = buildSceneLaunchPlan({
      mode: 'watch',
      configDraft,
      audioSnapshot: structuredClone(audioRuntimeSnapshotMock),
      overlayVisible: false,
      realtimeProfile: nativeProfile,
      speechPatch: { enabled: true },
      secondarySubtitleTranslationEnabled: false,
    });

    expect(plan.config.devices.feedbackLoopPrevention).toBe('process-exclusion');
    expect(plan.config.devices.aecEnabled).toBe(false);
    expect(plan.stages).toEqual(['bridge-ready', 'inbound-route']);
  });

  it('preserves legacy none for subtitles-only Watch instead of silently migrating it to AEC', () => {
    const configDraft = structuredClone(appConfigDraftMock);
    configDraft.devices.feedbackLoopPrevention = 'none';
    configDraft.devices.outputSpeechEnabled = false;
    configDraft.devices.aecEnabled = true;

    const plan = buildSceneLaunchPlan({
      mode: 'watch',
      configDraft,
      audioSnapshot: structuredClone(audioRuntimeSnapshotMock),
      overlayVisible: false,
      realtimeProfile: nativeProfile,
      speechPatch: { enabled: false },
      secondarySubtitleTranslationEnabled: false,
    });

    expect(plan.config.devices.feedbackLoopPrevention).toBe('none');
    expect(plan.config.devices.outputSpeechEnabled).toBe(false);
    expect(plan.config.devices.aecEnabled).toBe(false);
    expect(plan.stages).toEqual(['bridge-ready', 'inbound-route']);
  });

  it('maps the launch attempt id onto the native inbound route id', () => {
    const plan = buildSceneLaunchPlan({
      launchAttemptId: 'watch-attempt-42',
      mode: 'watch',
      configDraft: structuredClone(appConfigDraftMock),
      audioSnapshot: structuredClone(audioRuntimeSnapshotMock),
      overlayVisible: false,
      realtimeProfile: nativeProfile,
      speechPatch: { enabled: true },
      secondarySubtitleTranslationEnabled: false,
    });

    expect(plan.config.devices.inboundRoute.routeId).toBe('audio-route-inbound-watch-attempt-42');
  });

  it("omits translate-worker when translationExecution is prompted-realtime even if nativeTranslation is false", () => {
    const promptedRealtimeProfile = {
      nativeTranslation: false,
      speechDispatchPolicy: "subtitle-tts" as const,
      translationExecution: "prompted-realtime" as const,
      invocationOperation: "dialogue" as const,
    };
    const plan = buildSceneLaunchPlan({
      mode: "watch",
      configDraft: structuredClone(appConfigDraftMock),
      audioSnapshot: structuredClone(audioRuntimeSnapshotMock),
      overlayVisible: false,
      realtimeProfile: promptedRealtimeProfile,
      speechPatch: { enabled: false },
      secondarySubtitleTranslationEnabled: false,
    });
    expect(plan.stages).not.toContain("translate-worker");
    expect(plan.stages).toEqual(["bridge-ready", "inbound-route"]);
  });

  it("includes translate-worker when translationExecution is explicitly text-worker", () => {
    const asrTextProfile = {
      nativeTranslation: false,
      speechDispatchPolicy: "subtitle-tts" as const,
      translationExecution: "text-worker" as const,
      invocationOperation: "asr" as const,
    };
    const plan = buildSceneLaunchPlan({
      mode: "watch",
      configDraft: structuredClone(appConfigDraftMock),
      audioSnapshot: structuredClone(audioRuntimeSnapshotMock),
      overlayVisible: false,
      realtimeProfile: asrTextProfile,
      speechPatch: { enabled: false },
      secondarySubtitleTranslationEnabled: false,
    });
    expect(plan.stages).toContain("translate-worker");
    expect(plan.stages).toEqual(["bridge-ready", "inbound-route", "translate-worker"]);
  });

  it('launches translate-worker when conversation inbound is native translate but outbound is ASR/text-worker', () => {
    const plan = buildSceneLaunchPlan({
      mode: 'voice-room',
      configDraft: structuredClone(appConfigDraftMock),
      audioSnapshot: structuredClone(audioRuntimeSnapshotMock),
      overlayVisible: false,
      realtimeProfile: {
        nativeTranslation: true,
        speechDispatchPolicy: 'native-audio',
        translationExecution: 'dedicated-realtime',
        invocationOperation: 'native_translate',
      },
      outboundRealtimeProfile: {
        nativeTranslation: false,
        speechDispatchPolicy: 'subtitle-tts',
        translationExecution: 'text-worker',
        invocationOperation: 'asr',
      },
      speechPatch: { enabled: true },
      secondarySubtitleTranslationEnabled: false,
    });
    expect(plan.stages).toContain('translate-worker');
    expect(plan.stages).toContain('outbound-route');
  });

  it('ignores stale outboundRealtimeProfile in watch mode', () => {
    const plan = buildSceneLaunchPlan({
      mode: 'watch',
      configDraft: structuredClone(appConfigDraftMock),
      audioSnapshot: structuredClone(audioRuntimeSnapshotMock),
      overlayVisible: false,
      realtimeProfile: {
        nativeTranslation: true,
        speechDispatchPolicy: 'native-audio',
        translationExecution: 'dedicated-realtime',
        invocationOperation: 'native_translate',
      },
      outboundRealtimeProfile: {
        nativeTranslation: false,
        speechDispatchPolicy: 'subtitle-tts',
        translationExecution: 'text-worker',
        invocationOperation: 'asr',
      },
      speechPatch: { enabled: false },
      secondarySubtitleTranslationEnabled: false,
    });
    expect(plan.stages).not.toContain('translate-worker');
    expect(plan.stages).not.toContain('outbound-route');
    expect(plan.stages).toEqual(['bridge-ready', 'inbound-route']);
  });

  it('launches translate-worker when voice-room inbound is ASR/text-worker but outbound is native translate', () => {
    const plan = buildSceneLaunchPlan({
      mode: 'voice-room',
      configDraft: structuredClone(appConfigDraftMock),
      audioSnapshot: structuredClone(audioRuntimeSnapshotMock),
      overlayVisible: false,
      realtimeProfile: {
        nativeTranslation: false,
        speechDispatchPolicy: 'subtitle-tts',
        translationExecution: 'text-worker',
        invocationOperation: 'asr',
      },
      outboundRealtimeProfile: {
        nativeTranslation: true,
        speechDispatchPolicy: 'native-audio',
        translationExecution: 'dedicated-realtime',
        invocationOperation: 'native_translate',
      },
      speechPatch: { enabled: true },
      secondarySubtitleTranslationEnabled: false,
    });
    expect(plan.stages).toContain('translate-worker');
    expect(plan.stages).toContain('outbound-route');
    expect(plan.stages).toContain('inbound-route');
  });


  it('includes speech-dispatch when inbound is native translate but outbound is ASR with speech enabled', () => {
    const plan = buildSceneLaunchPlan({
      mode: 'voice-room',
      configDraft: structuredClone(appConfigDraftMock),
      audioSnapshot: {
        ...structuredClone(audioRuntimeSnapshotMock),
        speech: { ...structuredClone(audioRuntimeSnapshotMock.speech), dispatchState: 'idle' },
      },
      overlayVisible: false,
      realtimeProfile: {
        nativeTranslation: true,
        speechDispatchPolicy: 'native-audio',
        translationExecution: 'dedicated-realtime',
        invocationOperation: 'native_translate',
      },
      outboundRealtimeProfile: {
        nativeTranslation: false,
        speechDispatchPolicy: 'subtitle-tts',
        translationExecution: 'text-worker',
        invocationOperation: 'asr',
      },
      speechPatch: { enabled: true },
      secondarySubtitleTranslationEnabled: false,
    });
    expect(plan.stages).toContain('speech-dispatch');
    expect(plan.stages).toContain('translate-worker');
  });
});
