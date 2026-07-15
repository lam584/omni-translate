import { describe, expect, it } from 'vitest';
import { appConfigDraftMock } from '../../mocks/app-config';
import { audioRuntimeSnapshotMock } from '../../mocks/audio-runtime';
import { buildSceneLaunchPlan, buildWatchFallbackPlan } from './sceneLaunchPlan';

describe('buildSceneLaunchPlan', () => {
  const cases = [
    { name: 'watch omni', mode: 'watch' as const, omni: true, secondary: false,
      stages: ['bridge-ready', 'omni-preconnect', 'inbound-route', 'subtitle-overlay'] },
    { name: 'watch classic with speech', mode: 'watch' as const, omni: false, secondary: false,
      stages: ['bridge-ready', 'inbound-route', 'translate-worker', 'speech-dispatch', 'subtitle-overlay'] },
    { name: 'game', mode: 'game' as const, omni: false, secondary: false,
      stages: ['bridge-ready', 'inbound-route', 'outbound-route', 'translate-worker', 'speech-dispatch', 'subtitle-overlay'] },
    { name: 'voice room', mode: 'voice-room' as const, omni: false, secondary: false,
      stages: ['bridge-ready', 'outbound-route', 'translate-worker', 'speech-dispatch', 'subtitle-overlay'] },
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
        isOmniModel: testCase.omni,
        speechPatch: { enabled: true },
        secondarySubtitleTranslationEnabled: testCase.secondary,
      });
      expect(plan.stages).toEqual(testCase.stages);
      expect(plan.config.devices.routeMode).toBe(testCase.mode);
    });
  }

  it('builds complete non-Omni subtitles-only and Omni AEC fallback plans', () => {
    const base = {
      configDraft: structuredClone(appConfigDraftMock),
      audioSnapshot: structuredClone(audioRuntimeSnapshotMock),
      overlayVisible: false,
      secondarySubtitleTranslationEnabled: false,
    };
    expect(buildWatchFallbackPlan({ ...base, isOmniModel: false, speechPatch: { enabled: false } }).stages)
      .toEqual(['bridge-ready', 'inbound-route', 'translate-worker', 'subtitle-overlay']);
    expect(buildWatchFallbackPlan({ ...base, isOmniModel: true, speechPatch: { enabled: true } }).stages)
      .toEqual(['bridge-ready', 'inbound-route', 'speech-dispatch', 'subtitle-overlay']);
  });
});
