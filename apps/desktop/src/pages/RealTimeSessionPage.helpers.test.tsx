import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { appConfigDraftMock } from '../mocks/app-config';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import type { SubtitleCueRuntime } from '../schema/audio-runtime';
import type { AppConfigDraft } from '../schema/config';
import { useAppStore } from '../stores/app-store';
import { realTimeSessionPageHelpers } from './RealTimeSessionPage';

const {
  CueStatusBadge,
  CueSegmentRows,
  createLaunchAttemptId,
  describeSceneLaunchStage,
  describeRuntimeError,
  formatElapsed,
  formatLatencyMs,
  formatCueTiming,
  formatRuntimeClock,
  getSceneLaunchConfigurationProblem,
  getSceneLaunchConfigurationMessage,
  getSessionCueDisplaySegments,
  logSceneLaunchConfig,
  parseRuntimeTimestampMs,
  resolveSceneLabel,
  resolveSceneSpeechPatch,
  resolveSceneVoiceModelId,
  resolveVoiceModelRuntime,
} = realTimeSessionPageHelpers;

const baseCue: SubtitleCueRuntime = {
  cueId: 'cue-1',
  routeDirection: 'inbound',
  sourceText: 'hello',
  translatedText: '',
  startedAt: 'unix-ms:1',
  endedAt: 'unix-ms:2',
  committed: false,
};

/** Fresh config/runtime clones plus a silenced console.info spy for logSceneLaunchConfig tests. */
function sceneLaunchLogFixture() {
  return {
    configDraft: structuredClone(appConfigDraftMock),
    runtimeSnapshot: structuredClone(runtimeSnapshotMock),
    audioRuntimeSnapshot: structuredClone(audioRuntimeSnapshotMock),
    consoleSpy: vi.spyOn(console, 'info').mockImplementation(() => undefined),
  };
}

describe('realTimeSessionPageHelpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses runtime timestamps and rejects invalid values', () => {
    expect(parseRuntimeTimestampMs(null)).toBeNull();
    expect(parseRuntimeTimestampMs('')).toBeNull();
    expect(parseRuntimeTimestampMs('unix-ms:1779974788817')).toBe(1779974788817);
    expect(parseRuntimeTimestampMs('unix:123')).toBe(123_000);
    expect(parseRuntimeTimestampMs('2026-06-01T00:00:00.000Z')).toBe(Date.parse('2026-06-01T00:00:00.000Z'));
    expect(parseRuntimeTimestampMs('invalid')).toBeNull();
  });

  it('formats elapsed time, latency and scene labels', () => {
    expect(formatElapsed(Number.NaN)).toBe('00:00');
    expect(formatElapsed(65)).toBe('01:05');
    expect(formatElapsed(3661)).toBe('01:01:01');
    expect(formatLatencyMs(null)).toBe('--');
    expect(formatLatencyMs(Number.NaN)).toBe('--');
    expect(formatLatencyMs(123.6)).toBe('124 ms');
    expect(resolveSceneLabel('watch')).toBe('看片模式');
    expect(resolveSceneLabel('game')).toBe('文字转语音');
    expect(resolveSceneLabel('voice-room')).toBe('对话模式');
  });

  it('preserves structured desktop service errors for actionable launch feedback', () => {
    expect(describeRuntimeError({ code: 'bridge.install-failed', message: '驱动修复失败', retriable: true }))
      .toBe('驱动修复失败 (bridge.install-failed)');
  });

  it('formats runtime clocks and cue timing fallbacks', () => {
    expect(formatRuntimeClock(null)).toBe('--:--:--');
    expect(formatRuntimeClock('invalid')).toBe('--:--:--');
    expect(formatRuntimeClock('unix-ms:1779974788817')).not.toBe('--:--:--');

    expect(formatCueTiming({ ...baseCue, startedAt: 'unix-ms:1779974788817', endedAt: 'unix-ms:1779974788817' })).toContain(
      formatRuntimeClock('unix-ms:1779974788817'),
    );
    expect(formatCueTiming({ ...baseCue, startedAt: 'unix-ms:1779974788817', endedAt: '' })).not.toContain('unix-ms');
    expect(formatCueTiming({ ...baseCue, startedAt: 'unix-ms:1779974788817', endedAt: 'unix-ms:1779974798817' })).toContain(
      formatRuntimeClock('unix-ms:1779974798817'),
    );
  });

  it('recognizes realtime omni models with and without provider prefixes', () => {
    expect(resolveVoiceModelRuntime('provider::realtime-omni').isOmniModel).toBe(true);
    expect(resolveVoiceModelRuntime('realtime-livetranslate').isOmniModel).toBe(true);
    expect(resolveVoiceModelRuntime('provider::plain-model')).toEqual({
      voiceModelRaw: 'plain-model',
      isOmniModel: false,
    });
  });

  it('keeps the persisted output preference and falls back when its Windows endpoint ID changes', () => {
    const configDraft = structuredClone(appConfigDraftMock);
    const audioSnapshot = structuredClone(audioRuntimeSnapshotMock);
    const outputDevice = audioSnapshot.renderDevices[0];

    configDraft.devices.outputDeviceId = outputDevice.deviceId;
    configDraft.devices.playbackDeviceId = 'system-output-default';

    expect(getSceneLaunchConfigurationProblem('watch', configDraft, audioSnapshot)).toBeNull();

    configDraft.devices.outputDeviceId = 'missing-output-device';
    expect(getSceneLaunchConfigurationProblem('watch', configDraft, audioSnapshot)).toBeNull();

    audioSnapshot.renderDevices = [];
    expect(getSceneLaunchConfigurationProblem('watch', configDraft, audioSnapshot)).toBe('playback-device');
  });

  it('derives speech patches for every scene mode and watch fallback defaults', () => {
    const configDraft = structuredClone(useAppStore.getState().configDraft);

    expect(resolveSceneSpeechPatch('game', configDraft, false)).toMatchObject({
      enabled: true,
      outputTarget: 'speaker',
      localPlaybackEnabled: true,
      virtualMicOutputEnabled: false,
    });
    expect(resolveSceneSpeechPatch('voice-room', configDraft, false)).toMatchObject({
      enabled: true,
      outputTarget: 'speaker',
      localPlaybackEnabled: true,
      virtualMicOutputEnabled: false,
    });
    expect(resolveSceneSpeechPatch('watch', configDraft, false).enabled).toBe(false);

    const missingSpeech = { ...configDraft, speech: undefined } as unknown as AppConfigDraft;
    expect(resolveSceneSpeechPatch('watch', missingSpeech, true)).toMatchObject({
      enabled: configDraft.devices.outputSpeechEnabled,
      outputTarget: 'speaker',
      localPlaybackEnabled: true,
      virtualMicOutputEnabled: false,
    });
  });

  it('renders each cue status', () => {
    expect(renderToStaticMarkup(<CueStatusBadge cue={baseCue} />)).toContain('翻译中...');
    expect(renderToStaticMarkup(<CueStatusBadge cue={{ ...baseCue, committed: true, translatedText: '[翻译失败] timeout' }} />)).toContain('失败');
    expect(renderToStaticMarkup(<CueStatusBadge cue={{ ...baseCue, committed: true, translatedText: '你好' }} />)).toContain('已翻译');
    expect(renderToStaticMarkup(<CueStatusBadge cue={{ ...baseCue, committed: true }} />)).toContain('翻译失败');
  });
  it('logs scene launch config with populated optional fields', () => {
    const { configDraft, runtimeSnapshot, audioRuntimeSnapshot, consoleSpy } = sceneLaunchLogFixture();

    configDraft.providers[0].displayName = '';
    configDraft.providers[0].customHeaders = [{ id: 'h1', name: 'X-Test', value: '1', enabled: false }];
    configDraft.devices.inputDeviceId = '';
    configDraft.devices.outputDeviceId = '';
    configDraft.devices.virtualRenderDeviceId = '';
    configDraft.devices.playbackDeviceId = '';
    configDraft.devices.supportProfileId = '';
    configDraft.devices.inboundVoiceModelId = '';
    configDraft.devices.outboundVoiceModelId = '';
    configDraft.devices.textToSpeechModelId = '';
    configDraft.devices.subtitleTranslationModelId = '';
    configDraft.devices.outboundRoute.pushToTalk = undefined;
    configDraft.subtitles.instructions = '';
    configDraft.speech.voicePresetId = '';
    configDraft.speech.textToSpeechModelId = '';
    configDraft.speech.voice = '';
    configDraft.driver.targetDeviceId = '';
    configDraft.driver.expectedDriverVersion = '';
    configDraft.driver.expectedBridgeVersion = '';
    configDraft.driver.lastErrorCode = undefined;
    configDraft.driver.recommendedAction = undefined;
    configDraft.glossary.templateId = '';
    configDraft.glossary.calibrationModelId = '';
    runtimeSnapshot.bridge.driverVersion = null;
    runtimeSnapshot.bridge.sessionId = null;
    runtimeSnapshot.bridge.lastHandshakeAt = null;
    runtimeSnapshot.bridge.lastErrorCode = null;
    runtimeSnapshot.bridge.recommendedAction = null;
    runtimeSnapshot.bridge.endpointName = null;
    runtimeSnapshot.bridge.abiVersion = null;
    audioRuntimeSnapshot.sessionStartedAt = null;

    logSceneLaunchConfig('watch', configDraft, runtimeSnapshot, audioRuntimeSnapshot, {
      speechPatch: { enabled: true },
      isOmniModel: true,
      secondarySubtitleTranslationEnabled: true,
    });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const logOutput = String(consoleSpy.mock.calls[0]?.[2] ?? '');
    expect(logOutput).toContain('Provider[0]');
    expect(logOutput).toContain('X-Test=disabled');
    expect(logOutput).toContain('speechPatch');
  });

  it('logs scene launch config when speech is missing and JSON backup fails', () => {
    const fixture = sceneLaunchLogFixture();
    const configDraft = fixture.configDraft as AppConfigDraft & { circular?: unknown };
    const { runtimeSnapshot, audioRuntimeSnapshot, consoleSpy } = fixture;

    configDraft.speech = undefined as unknown as AppConfigDraft['speech'];
    configDraft.circular = configDraft;

    logSceneLaunchConfig('voice-room', configDraft, runtimeSnapshot, audioRuntimeSnapshot);

    const logOutput = String(consoleSpy.mock.calls[0]?.[2] ?? '');
    expect(logOutput).toContain('speech');
    expect(logOutput).toContain('JSON');
  });

  it('logs enabled custom headers', () => {
    const { configDraft, runtimeSnapshot, audioRuntimeSnapshot, consoleSpy } = sceneLaunchLogFixture();

    configDraft.providers[0].customHeaders = [{ id: 'h-enabled', name: 'X-Enabled', value: '1', enabled: true }];

    logSceneLaunchConfig('watch', configDraft, runtimeSnapshot, audioRuntimeSnapshot);

    expect(String(consoleSpy.mock.calls[0]?.[2] ?? '')).toContain('X-Enabled=enabled');
  });

  it('falls back safely when inline values and the full config cannot be serialized', () => {
    const fixture = sceneLaunchLogFixture();
    const configDraft = fixture.configDraft as AppConfigDraft & { unsupported?: bigint };
    const { runtimeSnapshot, audioRuntimeSnapshot, consoleSpy } = fixture;
    const speechPatch = { enabled: true } as Record<string, unknown> & { enabled: boolean };
    speechPatch.self = speechPatch;
    configDraft.unsupported = 1n;

    logSceneLaunchConfig('watch', configDraft, runtimeSnapshot, audioRuntimeSnapshot, {
      speechPatch: speechPatch as never,
      isOmniModel: false,
      secondarySubtitleTranslationEnabled: false,
    });

    const output = String(consoleSpy.mock.calls[0]?.[2] ?? '');
    expect(output).toContain('[object Object]');
    expect(output).toContain('(serialization failed)');
  });

  it('normalizes every runtime error shape', () => {
    expect(describeRuntimeError(new Error('native failed'))).toBe('native failed');
    expect(describeRuntimeError({ message: 'plain message', code: 7 })).toBe('plain message');
    expect(describeRuntimeError({ value: 1 })).toBe('{"value":1}');
    expect(describeRuntimeError('rejected')).toBe('rejected');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeRuntimeError(circular)).toBe('[object Object]');
  });

  it('creates launch ids with crypto and fallback entropy', () => {
    const randomUuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000');
    expect(createLaunchAttemptId('watch')).toBe('watch-00000000-0000-4000-8000-000000000000');
    randomUuid.mockRestore();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
    vi.spyOn(Date, 'now').mockReturnValue(123);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(createLaunchAttemptId('game')).toMatch(/^game-123-/);
    Object.defineProperty(globalThis, 'crypto', descriptor!);
  });

  it('validates missing scene models and voice-room capture devices', () => {
    const configDraft = structuredClone(appConfigDraftMock);
    const audioSnapshot = structuredClone(audioRuntimeSnapshotMock);
    configDraft.devices.inboundVoiceModelId = '';
    expect(getSceneLaunchConfigurationProblem('watch', configDraft, audioSnapshot)).toBe('model');
    configDraft.devices.inboundVoiceModelId = 'inbound';
    configDraft.devices.outboundVoiceModelId = '';
    expect(getSceneLaunchConfigurationProblem('voice-room', configDraft, audioSnapshot)).toBe('model');
    configDraft.devices.outboundVoiceModelId = 'outbound';
    configDraft.devices.inboundVoiceModelId = '';
    expect(getSceneLaunchConfigurationProblem('voice-room', configDraft, audioSnapshot)).toBe('model');
    configDraft.devices.inboundVoiceModelId = 'inbound';
    configDraft.devices.inputDeviceId = 'missing';
    expect(getSceneLaunchConfigurationProblem('voice-room', configDraft, audioSnapshot)).toBe('input-device');
    expect(getSceneLaunchConfigurationProblem('game', configDraft, audioSnapshot)).toBeNull();
    expect(resolveSceneVoiceModelId('voice-room', configDraft)).toBe('outbound');
    expect(resolveSceneVoiceModelId('game', configDraft)).toBe('inbound');
  });

  it('provides localized messages for every configuration problem', () => {
    for (const problem of ['model', 'input-device', 'playback-device'] as const) {
      expect(getSceneLaunchConfigurationMessage(problem, true)).toEqual(expect.any(String));
      expect(getSceneLaunchConfigurationMessage(problem, false)).toEqual(expect.any(String));
    }
  });

  it('labels every launch stage and the unknown fallback', () => {
    for (const stage of ['omni-preconnect', 'bridge-ready', 'inbound-route', 'outbound-route', 'translate-worker', 'speech-dispatch', 'subtitle-overlay', 'fallback-route', null] as const) {
      expect(describeSceneLaunchStage(stage)).toEqual(expect.any(String));
    }
  });

  it('uses authoritative matching segments and rebuilds stale segments', () => {
    const matching = {
      ...baseCue,
      displaySourceText: 'hello',
      translatedText: '你好',
      displaySegments: [{ sourceText: 'hello', translatedText: '你好', pending: false }],
    };
    expect(getSessionCueDisplaySegments(matching)).toHaveLength(1);
    expect(getSessionCueDisplaySegments({ ...matching, displaySegments: [] })[0]).toMatchObject({ sourceText: 'hello' });
    expect(getSessionCueDisplaySegments({ ...baseCue, displaySegments: undefined })).toHaveLength(1);
  });

  it('renders empty, pending, untranslated and translated cue segment states', () => {
    const emptyCommitted = renderToStaticMarkup(<CueSegmentRows cue={{ ...baseCue, sourceText: '', committed: true }} />);
    const emptyPending = renderToStaticMarkup(<CueSegmentRows cue={{ ...baseCue, sourceText: '', committed: false }} current />);
    const untranslated = renderToStaticMarkup(<CueSegmentRows cue={{ ...baseCue, committed: true, displaySegments: [{ sourceText: 'source', translatedText: '', pending: false }] }} />);
    const failed = renderToStaticMarkup(<CueSegmentRows cue={{ ...baseCue, translatedText: '[翻译失败] bad', committed: true }} current />);
    expect(emptyCommitted).toContain('翻译失败');
    expect(emptyPending).toContain('正在调用');
    expect(untranslated).toContain('翻译失败');
    expect(failed).toContain('cue-queue-error');
  });

  it('does not label source-only rows as failed when the committed cue has a translation', () => {
    // Regression: native watch-mode turns can return a translation covering
    // only part of the source. The cue renders as a source block followed by
    // a translation block; those source rows are not failures.
    const partialBlock = renderToStaticMarkup(<CueSegmentRows cue={{
      ...baseCue,
      committed: true,
      translatedText: '他的手瘫痪了。',
      displaySourceText: 'His hands are paralyzed. Okay.',
      displaySegments: [
        { sourceText: 'His hands are paralyzed.', translatedText: '', pending: false },
        { sourceText: 'Okay.', translatedText: '', pending: false },
        { sourceText: '', translatedText: '他的手瘫痪了。', pending: false },
      ],
    }} />);
    expect(partialBlock).not.toContain('翻译失败');
    expect(partialBlock).toContain('他的手瘫痪了。');
    expect(partialBlock).toContain('His hands are paralyzed.');
  });
});
