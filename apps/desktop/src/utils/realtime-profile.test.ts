import { describe, expect, it } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';
import type { ProviderDraft } from '../schema/config';
import type { RealtimeProtocol } from '../schema/config';
import { resolveRealtimeProfile } from './realtime-profile';

function configWith(provider: ProviderDraft) {
  return { providers: [provider] };
}

function dashscope(model = 'qwen-audio-3.0-realtime-plus') {
  const provider = structuredClone(appConfigDraftMock.providers[0]);
  provider.model = model;
  provider.sceneModelAssignments = [];
  provider.localModelCapabilityRegistry = [];
  return provider;
}

describe('resolveRealtimeProfile', () => {
  it('resolves bare and composite aliases from an exact registry protocol', () => {
    const provider = dashscope();
    provider.localModelCapabilityRegistry = [{
      id: 'alias', modelId: 'qwen-audio-3.0-realtime-plus',
      capabilities: ['speech-to-text', 'speech-to-speech'],
      realtimeProtocol: 'dashscope-omni', realtimeAudioMode: 'server_vad',
      interactionCapabilities: ['streaming', 'auto_vad'],
    }];

    for (const reference of [provider.model, `${provider.templateId}::${provider.model}`]) {
      const profile = resolveRealtimeProfile(configWith(provider), reference);
      expect(profile.routeKind).toBe('omni');
      expect(profile.protocolDialect).toBe('dashscope-omni');
      expect(profile.serverSegmentation).toBe(true);
      expect(profile.preconnectPolicy).toBe('allowed');
      expect(profile.timeoutBudgetMs).toBe(95_000);
    }
  });

  it('routes an unhinted alias from explicit protocol without name inference', () => {
    const provider = dashscope('deployment-blue');
    provider.localModelCapabilityRegistry = [{
      id: 'blue', modelId: 'deployment-blue', capabilities: ['speech-to-speech'],
      realtimeProtocol: 'dashscope-livetranslate', realtimeAudioMode: 'server_vad',
      interactionCapabilities: ['streaming'],
    }];
    expect(resolveRealtimeProfile(configWith(provider), 'deployment-blue')).toMatchObject({
      routeKind: 'omni', protocolDialect: 'dashscope-livetranslate', source: 'registry',
      inputFormat: 'pcm', nativeTranslation: true,
    });
  });

  it('lets an exact STT-only registry entry deny an omni-looking name', () => {
    const provider = dashscope('named-omni-realtime');
    provider.localModelCapabilityRegistry = [{
      id: 'deny', modelId: provider.model, capabilities: ['speech-to-text'],
      realtimeAudioMode: 'server_vad', interactionCapabilities: ['streaming'],
    }];
    expect(resolveRealtimeProfile(configWith(provider), provider.model)).toMatchObject({
      routeKind: 'local-vad', protocolDialect: null, source: 'registry',
    });
  });

  it('does not treat S2S without streaming or a non-DashScope capability match as omni', () => {
    const missingStreaming = dashscope('alias-without-streaming');
    missingStreaming.localModelCapabilityRegistry = [{
      id: 'no-stream', modelId: missingStreaming.model, capabilities: ['speech-to-speech'],
      realtimeAudioMode: 'server_vad', interactionCapabilities: [],
    }];
    expect(resolveRealtimeProfile(configWith(missingStreaming), missingStreaming.model).routeKind).toBe('local-vad');

    const nonDashscope = dashscope('same-capabilities');
    nonDashscope.kind = 'openai-compatible';
    nonDashscope.templateId = 'template-custom';
    nonDashscope.localModelCapabilityRegistry = [{
      id: 'other', modelId: nonDashscope.model, capabilities: ['speech-to-speech'],
      realtimeAudioMode: 'server_vad', interactionCapabilities: ['streaming'],
    }];
    expect(resolveRealtimeProfile(configWith(nonDashscope), nonDashscope.model).routeKind).toBe('local-vad');
  });

  it('keeps the first duplicate registry entry and emits a diagnostic', () => {
    const provider = dashscope('duplicate-alias');
    provider.localModelCapabilityRegistry = [
      { id: 'first', modelId: provider.model, capabilities: ['speech-to-text'], realtimeProtocol: 'dashscope-asr' },
      { id: 'second', modelId: provider.model, capabilities: ['speech-to-speech'], realtimeProtocol: 'dashscope-omni' },
    ];
    const profile = resolveRealtimeProfile(configWith(provider), provider.model);
    expect(profile.protocolDialect).toBe('dashscope-asr');
    expect(profile.diagnostics[0]).toContain("first entry 'first'");
  });

  it('applies template then provider then name fallback precedence', () => {
    const provider = dashscope('omni-realtime-alias');
    provider.templateRealtimeProtocol = 'dashscope-asr';
    provider.realtimeProtocol = 'dashscope-omni';
    expect(resolveRealtimeProfile(configWith(provider), provider.model)).toMatchObject({
      protocolDialect: 'dashscope-asr', source: 'template',
    });
    delete provider.templateRealtimeProtocol;
    expect(resolveRealtimeProfile(configWith(provider), provider.model)).toMatchObject({
      protocolDialect: 'dashscope-omni', source: 'provider',
    });
    delete provider.realtimeProtocol;
    expect(resolveRealtimeProfile(configWith(provider), provider.model)).toMatchObject({
      protocolDialect: 'dashscope-omni', source: 'model-name',
    });
  });

  it('covers every explicit protocol with standard and unhinted bare/composite IDs', () => {
    const matrix: Array<{
      protocol: RealtimeProtocol;
      standard: string;
      kind: ProviderDraft['kind'];
      routeKind: string;
      inputFormat: string;
      sampleRate: number;
    }> = [
      { protocol: 'dashscope-omni', standard: 'qwen3.5-omni-plus-realtime', kind: 'dashscope', routeKind: 'omni', inputFormat: 'pcm16', sampleRate: 16_000 },
      { protocol: 'dashscope-livetranslate', standard: 'qwen3-livetranslate-flash-realtime', kind: 'dashscope', routeKind: 'omni', inputFormat: 'pcm', sampleRate: 16_000 },
      { protocol: 'dashscope-asr', standard: 'qwen3-asr-flash-realtime', kind: 'dashscope', routeKind: 'dashscope-asr', inputFormat: 'pcm', sampleRate: 16_000 },
      { protocol: 'openai-conversation', standard: 'gpt-realtime', kind: 'openai-compatible', routeKind: 'openai-realtime', inputFormat: 'pcm16', sampleRate: 24_000 },
      { protocol: 'openai-translation', standard: 'gpt-realtime-translate', kind: 'openai-compatible', routeKind: 'openai-realtime', inputFormat: 'pcm16', sampleRate: 24_000 },
      { protocol: 'openai-transcription', standard: 'gpt-realtime-whisper', kind: 'openai-compatible', routeKind: 'openai-realtime', inputFormat: 'pcm16', sampleRate: 24_000 },
      { protocol: 'openai-flat', standard: 'vendor-realtime-flat', kind: 'openai-compatible', routeKind: 'openai-realtime', inputFormat: 'pcm16', sampleRate: 16_000 },
      { protocol: 'gemini-live', standard: 'gemini-2.5-flash-live', kind: 'openai-compatible', routeKind: 'gemini-live', inputFormat: 'pcm16', sampleRate: 16_000 },
    ];

    for (const [index, row] of matrix.entries()) {
      for (const modelId of [row.standard, `deployment-${index}`]) {
        const provider = dashscope(modelId);
        provider.kind = row.kind;
        provider.localModelCapabilityRegistry = [{
          id: `${row.protocol}-${modelId}`,
          modelId,
          capabilities: [],
          interactionCapabilities: [],
          realtimeProtocol: row.protocol,
        }];
        for (const reference of [modelId, `${provider.templateId}::${modelId}`]) {
          expect(resolveRealtimeProfile(configWith(provider), reference)).toMatchObject({
            protocolDialect: row.protocol,
            routeKind: row.routeKind,
            inputFormat: row.inputFormat,
            sampleRate: row.sampleRate,
            source: 'registry',
          });
        }
      }
    }
  });

  it('infers each supported protocol family from unregistered provider model names', () => {
    const inferredProfile = (modelId: string, kind: ProviderDraft['kind'], templateId: string) => {
      const provider = dashscope(modelId);
      provider.kind = kind;
      provider.templateId = templateId;
      provider.localModelCapabilityRegistry = [];
      delete provider.templateRealtimeProtocol;
      delete provider.realtimeProtocol;
      return resolveRealtimeProfile(configWith(provider), modelId);
    };

    for (const modelId of [
      'gemini-flash-live',
      'gemini-flash-realtime',
      'gemini-flash-native-audio',
    ]) {
      expect(inferredProfile(modelId, 'openai-compatible', 'template-gemini')).toMatchObject({
        protocolDialect: 'gemini-live',
        routeKind: 'gemini-live',
        realtimeAudioMode: 'gemini_auto_activity',
        nativeAudioOutput: true,
        source: 'model-name',
      });
    }

    expect(inferredProfile('qwen-livetranslate-v2', 'dashscope', 'template-dashscope')).toMatchObject({
      protocolDialect: 'dashscope-livetranslate', routeKind: 'omni', nativeTranslation: true,
    });
    expect(inferredProfile('qwen-omni-realtime-v2', 'dashscope', 'template-dashscope')).toMatchObject({
      protocolDialect: 'dashscope-omni', realtimeAudioMode: 'manual', nativeAudioOutput: true,
    });
    expect(inferredProfile('qwen-audio-realtime-v2', 'openai-compatible', 'template-custom')).toMatchObject({
      protocolDialect: 'dashscope-omni', routeKind: 'omni', source: 'model-name',
    });
    expect(inferredProfile('qwen-asr-realtime-v2', 'dashscope', 'template-dashscope')).toMatchObject({
      protocolDialect: 'dashscope-asr', routeKind: 'dashscope-asr', nativeAudioOutput: false,
    });
    expect(inferredProfile('deployment-without-hints', 'dashscope', 'template-dashscope')).toMatchObject({
      protocolDialect: 'dashscope-omni', source: 'model-name',
    });

    expect(inferredProfile('gpt-translate-v2', 'openai-compatible', 'template-custom')).toMatchObject({
      protocolDialect: 'openai-translation', nativeTranslation: true, speechDispatchPolicy: 'disabled',
    });
    expect(inferredProfile('gpt-transcribe-v2', 'openai-compatible', 'template-custom')).toMatchObject({
      protocolDialect: 'openai-transcription', realtimeAudioMode: 'server_vad',
    });
    expect(inferredProfile('gpt-whisper-v2', 'openai-compatible', 'template-custom')).toMatchObject({
      protocolDialect: 'openai-transcription', realtimeAudioMode: 'manual',
    });
    expect(inferredProfile('gpt-realtime-v2', 'openai-compatible', 'template-custom')).toMatchObject({
      protocolDialect: 'openai-conversation', nativeAudioOutput: true,
    });
    expect(inferredProfile('gpt-live-v2', 'openai-compatible', 'template-custom')).toMatchObject({
      protocolDialect: 'openai-conversation', source: 'model-name',
    });
    expect(inferredProfile('plain-text-model', 'openai-compatible', 'template-custom')).toMatchObject({
      protocolDialect: null, routeKind: 'local-vad', speechDispatchPolicy: 'subtitle-tts', source: 'none',
    });
  });

  it('resolves an unknown composite reference without a provider as a local profile', () => {
    expect(resolveRealtimeProfile({ providers: [] }, 'missing-template::plain-model')).toMatchObject({
      providerId: null,
      modelId: 'plain-model',
      protocolDialect: null,
      routeKind: 'local-vad',
      preconnectPolicy: 'disabled',
      timeoutBudgetMs: 30_000,
    });
  });
});
