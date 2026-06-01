import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SubtitleCueRuntime } from '../schema/audio-runtime';
import type { AppConfigDraft } from '../schema/config';
import { useAppStore } from '../stores/app-store';
import { realTimeSessionPageHelpers } from './RealTimeSessionPage';

const {
  CueStatusBadge,
  formatElapsed,
  formatLatencyMs,
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
    expect(resolveSceneLabel('game')).toBe('对话模式');
    expect(resolveSceneLabel('voice-room')).toBe('对话模式');
  });

  it('recognizes realtime omni models with and without provider prefixes', () => {
    expect(resolveVoiceModelRuntime('provider::realtime-omni').isOmniModel).toBe(true);
    expect(resolveVoiceModelRuntime('realtime-livetranslate').isOmniModel).toBe(true);
    expect(resolveVoiceModelRuntime('provider::plain-model')).toEqual({
      voiceModelRaw: 'plain-model',
      isOmniModel: false,
    });
  });

  it('derives speech patches for every scene mode and watch fallback defaults', () => {
    const configDraft = structuredClone(useAppStore.getState().configDraft);

    expect(resolveSceneSpeechPatch('game', configDraft, false)).toMatchObject({
      enabled: true,
      outputTarget: 'both',
      localPlaybackEnabled: true,
      virtualMicOutputEnabled: true,
    });
    expect(resolveSceneSpeechPatch('voice-room', configDraft, false)).toMatchObject({
      enabled: true,
      outputTarget: 'virtual-mic',
      localPlaybackEnabled: false,
      virtualMicOutputEnabled: true,
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
});
