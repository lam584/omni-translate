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
  describeRuntimeError,
  formatElapsed,
  formatLatencyMs,
  formatCueTiming,
  formatRuntimeClock,
  getSceneLaunchConfigurationProblem,
  logSceneLaunchConfig,
  parseRuntimeTimestampMs,
  resolveSceneLabel,
  resolveSceneSpeechPatch,
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

describe('realTimeSessionPageHelpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses runtime timestamps and rejects invalid values', () => {
    expect(parseRuntimeTimestampMs(null)).toBeNull();
    expect(parseRuntimeTimestampMs('')).toBeNull();
    expect(parseRuntimeTimestampMs('unix-ms:1779974788817')).toBe(1779974788817);
    expect(parseRuntimeTimestampMs('unix:123')).toBe(123);
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

  it('validates the output device selected by Audio Routing instead of the legacy playback preference', () => {
    const configDraft = structuredClone(appConfigDraftMock);
    const audioSnapshot = structuredClone(audioRuntimeSnapshotMock);
    const outputDevice = audioSnapshot.renderDevices[0];

    configDraft.devices.outputDeviceId = outputDevice.deviceId;
    configDraft.devices.playbackDeviceId = 'system-output-default';

    expect(getSceneLaunchConfigurationProblem('watch', configDraft, audioSnapshot)).toBeNull();

    configDraft.devices.outputDeviceId = 'missing-output-device';
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
    const configDraft = structuredClone(appConfigDraftMock);
    const runtimeSnapshot = structuredClone(runtimeSnapshotMock);
    const audioRuntimeSnapshot = structuredClone(audioRuntimeSnapshotMock);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

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
    const logOutput = String(consoleSpy.mock.calls[0]?.[0] ?? '');
    expect(logOutput).toContain('Provider[0]');
    expect(logOutput).toContain('X-Test=disabled');
    expect(logOutput).toContain('speechPatch');
  });

  it('logs scene launch config when speech is missing and JSON backup fails', () => {
    const configDraft = structuredClone(appConfigDraftMock) as AppConfigDraft & { circular?: unknown };
    const runtimeSnapshot = structuredClone(runtimeSnapshotMock);
    const audioRuntimeSnapshot = structuredClone(audioRuntimeSnapshotMock);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    configDraft.speech = undefined as unknown as AppConfigDraft['speech'];
    configDraft.circular = configDraft;

    logSceneLaunchConfig('voice-room', configDraft, runtimeSnapshot, audioRuntimeSnapshot);

    const logOutput = String(consoleSpy.mock.calls[0]?.[0] ?? '');
    expect(logOutput).toContain('speech');
    expect(logOutput).toContain('JSON');
  });

  it('logs enabled custom headers', () => {
    const configDraft = structuredClone(appConfigDraftMock);
    const runtimeSnapshot = structuredClone(runtimeSnapshotMock);
    const audioRuntimeSnapshot = structuredClone(audioRuntimeSnapshotMock);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    configDraft.providers[0].customHeaders = [{ id: 'h-enabled', name: 'X-Enabled', value: '1', enabled: true }];

    logSceneLaunchConfig('watch', configDraft, runtimeSnapshot, audioRuntimeSnapshot);

    expect(String(consoleSpy.mock.calls[0]?.[0] ?? '')).toContain('X-Enabled=enabled');
  });
});
