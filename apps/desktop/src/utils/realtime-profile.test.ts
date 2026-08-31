import { describe, expect, it } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';
import { MODEL_PROTOCOL_REGISTRY } from '../model-protocol/profile-registry';
import type { ProviderDraft, ProviderModelCapabilityRegistryEntry, RealtimeProtocol } from '../schema/config';
import {
  RealtimeProfileAuthorizationError,
  resolveRealtimeProfile,
} from './realtime-profile';

const LIVE_TRANSLATE_MODEL = 'qwen3.5-livetranslate-flash-realtime';
const OMNI_MODEL = 'qwen3.5-omni-plus-realtime';
const CROSS_KIND_BAILIAN_MODELS = [
  'qwen-audio-3.0-realtime-plus',
  'qwen3-asr-flash-realtime',
  'qwen3-tts-instruct-flash-realtime-2026-01-22',
] as const;

function configWith(provider: ProviderDraft) {
  return { providers: [provider] };
}

function providerFor(
  model: string,
  kind: ProviderDraft['kind'] = 'dashscope',
  templateId = kind === 'dashscope' ? 'template-dashscope-realtime' : 'template-custom',
) {
  const provider = structuredClone(appConfigDraftMock.providers[0]);
  provider.kind = kind;
  provider.templateId = templateId;
  provider.model = model;
  provider.sceneModelAssignments = [];
  provider.localModelCapabilityRegistry = [];
  delete provider.templateRealtimeProtocol;
  delete provider.realtimeProtocol;
  return provider;
}

function seededEntry(modelId: string): ProviderModelCapabilityRegistryEntry {
  const entry = appConfigDraftMock.providers[0].localModelCapabilityRegistry.find((candidate) => candidate.modelId === modelId);
  if (!entry) throw new Error(`missing seeded registry entry for ${modelId}`);
  return structuredClone(entry);
}

function expectProtocolError(
  action: () => unknown,
  code: RealtimeProfileAuthorizationError['code'],
) {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RealtimeProfileAuthorizationError);
  expect(caught).toMatchObject({ code, message: code });
}

describe('resolveRealtimeProfile', () => {
  it('authorizes the exact LiveTranslate profile for bare and composite references', () => {
    const provider = providerFor(LIVE_TRANSLATE_MODEL);
    const entry = seededEntry(LIVE_TRANSLATE_MODEL);
    // A legacy local override is UI metadata and cannot replace manifest authority.
    entry.realtimeProtocol = 'dashscope-omni';
    provider.localModelCapabilityRegistry = [entry];

    for (const reference of [provider.model, `${provider.templateId}::${provider.model}`]) {
      expect(resolveRealtimeProfile(configWith(provider), reference)).toMatchObject({
        routeKind: 'omni',
        protocolDialect: 'dashscope-livetranslate',
        realtimeAudioMode: 'server_vad',
        inputFormat: 'pcm',
        sampleRate: 16_000,
        serverSegmentation: true,
        nativeTranslation: true,
        nativeAudioOutput: true,
        preconnectPolicy: 'allowed',
        timeoutBudgetMs: 95_000,
        source: 'manifest',
      });
    }
  });

  it('authorizes a manifest-known LiveTranslate model without a local UI registry row', () => {
    const provider = providerFor(LIVE_TRANSLATE_MODEL);
    expect(resolveRealtimeProfile(configWith(provider), provider.model)).toMatchObject({
      modelId: LIVE_TRANSLATE_MODEL,
      protocolDialect: 'dashscope-livetranslate',
      source: 'manifest',
    });
  });

  it('rejects every manifest-known Bailian voice product under an OpenAI-compatible provider', () => {
    for (const modelId of [LIVE_TRANSLATE_MODEL, OMNI_MODEL, ...CROSS_KIND_BAILIAN_MODELS]) {
      for (const templateId of ['template-custom', 'template-dashscope-realtime']) {
        const provider = providerFor(modelId, 'openai-compatible', templateId);
        expectProtocolError(
          () => resolveRealtimeProfile(configWith(provider), modelId),
          'model_protocol.authorization_identity_mismatch',
        );
      }
    }
  });

  it('rejects a manifest-known Bailian voice model when no provider owns the reference', () => {
    expectProtocolError(
      () => resolveRealtimeProfile({ providers: [] }, LIVE_TRANSLATE_MODEL),
      'model_protocol.authorization_identity_mismatch',
    );
  });

  it('keeps active and ambiguous provider selection deterministic and fail closed', () => {
    const activeOpenAi = providerFor('gpt-realtime-active', 'openai-compatible');
    const inactiveDashScope = providerFor(LIVE_TRANSLATE_MODEL);
    expect(resolveRealtimeProfile({
      activeProviderTemplateId: activeOpenAi.templateId,
      providers: [inactiveDashScope, activeOpenAi],
    }, 'unbound-realtime-model')).toMatchObject({
      providerId: null,
      protocolDialect: null,
      routeKind: 'local-vad',
    });

    expect(resolveRealtimeProfile({
      activeProviderTemplateId: 'missing-template',
      providers: [inactiveDashScope],
    }, 'unbound-realtime-model')).toMatchObject({
      providerId: null,
      protocolDialect: null,
      routeKind: 'local-vad',
    });

    const secondDashScope = providerFor(LIVE_TRANSLATE_MODEL);
    secondDashScope.templateId = 'template-dashscope-secondary';
    expect(resolveRealtimeProfile({
      providers: [inactiveDashScope, secondDashScope],
    }, 'unbound-realtime-model')).toMatchObject({
      providerId: null,
      protocolDialect: null,
      routeKind: 'local-vad',
    });

    expectProtocolError(
      () => resolveRealtimeProfile({ providers: [inactiveDashScope] }, 'unbound-realtime-model'),
      'model_protocol.model_not_registered',
    );
  });

  it('rejects an unknown DashScope model despite template, provider, and name hints', () => {
    const provider = providerFor('future-omni-realtime-2099');
    provider.templateRealtimeProtocol = 'dashscope-omni';
    provider.realtimeProtocol = 'dashscope-livetranslate';
    expectProtocolError(
      () => resolveRealtimeProfile(configWith(provider), provider.model),
      'model_protocol.model_not_registered',
    );

    const activeProvider = providerFor(LIVE_TRANSLATE_MODEL);
    expectProtocolError(
      () => resolveRealtimeProfile(
        { activeProviderTemplateId: activeProvider.templateId, providers: [activeProvider] },
        'unbound-future-omni-realtime-2099',
      ),
      'model_protocol.model_not_registered',
    );
  });

  it('rejects an exact local entry when its manifest declaration is missing', () => {
    const provider = providerFor(LIVE_TRANSLATE_MODEL);
    const entry = seededEntry(LIVE_TRANSLATE_MODEL);
    delete entry.registryVersion;
    delete entry.profileId;
    delete entry.profileVersion;
    provider.localModelCapabilityRegistry = [entry];
    provider.templateRealtimeProtocol = 'dashscope-omni';

    expectProtocolError(
      () => resolveRealtimeProfile(configWith(provider), provider.model),
      'model_protocol.authorization_identity_mismatch',
    );
  });

  it('rejects mismatched local manifest declarations instead of falling back', () => {
    const cases: Array<{
      patch: Partial<ProviderModelCapabilityRegistryEntry>;
      code: RealtimeProfileAuthorizationError['code'];
    }> = [
      { patch: { registryVersion: 'bailian-model-protocol-registry/v0' }, code: 'model_protocol.registry_version_mismatch' },
      { patch: { profileId: 'bailian.omni.realtime.ws' }, code: 'model_protocol.profile_id_mismatch' },
      { patch: { profileVersion: 99 }, code: 'model_protocol.profile_version_mismatch' },
    ];

    for (const { patch, code } of cases) {
      const provider = providerFor(LIVE_TRANSLATE_MODEL);
      provider.localModelCapabilityRegistry = [{ ...seededEntry(LIVE_TRANSLATE_MODEL), ...patch }];
      expectProtocolError(() => resolveRealtimeProfile(configWith(provider), provider.model), code);
    }
  });

  it('rejects manifest-only adapters before connection', () => {
    const provider = providerFor(OMNI_MODEL);
    provider.localModelCapabilityRegistry = [seededEntry(OMNI_MODEL)];
    expectProtocolError(
      () => resolveRealtimeProfile(configWith(provider), provider.model),
      'model_protocol.adapter_unavailable',
    );
  });

  it('rejects unknown snapshots and manifest-only LiveTranslate snapshots', () => {
    expectProtocolError(
      () => resolveRealtimeProfile(
        configWith(providerFor('qwen3.5-livetranslate-flash-realtime-2099-01-01')),
        'qwen3.5-livetranslate-flash-realtime-2099-01-01',
      ),
      'model_protocol.model_not_registered',
    );
    expectProtocolError(
      () => resolveRealtimeProfile(
        configWith(providerFor('qwen3.5-livetranslate-flash-realtime-2026-05-19')),
        'qwen3.5-livetranslate-flash-realtime-2026-05-19',
      ),
      'model_protocol.adapter_unavailable',
    );
  });

  it('does not admit ASR-only or TTS-only profiles to native Watch translation', () => {
    for (const modelId of [
      'qwen3-asr-flash-realtime',
      'qwen3-tts-instruct-flash-realtime-2026-01-22',
    ]) {
      expectProtocolError(
        () => resolveRealtimeProfile(configWith(providerFor(modelId)), modelId),
        'model_protocol.operation_not_supported',
      );
    }
  });

  it('rejects transport, region, and operation mismatches with stable codes', () => {
    const transportMismatch = providerFor(LIVE_TRANSLATE_MODEL);
    transportMismatch.transport = 'http';
    transportMismatch.localModelCapabilityRegistry = [seededEntry(LIVE_TRANSLATE_MODEL)];
    expectProtocolError(
      () => resolveRealtimeProfile(configWith(transportMismatch), transportMismatch.model),
      'model_protocol.transport_mismatch',
    );

    const regionMismatch = providerFor(LIVE_TRANSLATE_MODEL);
    regionMismatch.region = 'eu-west-1';
    regionMismatch.localModelCapabilityRegistry = [seededEntry(LIVE_TRANSLATE_MODEL)];
    expectProtocolError(
      () => resolveRealtimeProfile(configWith(regionMismatch), regionMismatch.model),
      'model_protocol.region_not_supported',
    );

    const operationMismatch = providerFor(LIVE_TRANSLATE_MODEL);
    operationMismatch.localModelCapabilityRegistry = [seededEntry(LIVE_TRANSLATE_MODEL)];
    expectProtocolError(
      () => resolveRealtimeProfile(configWith(operationMismatch), operationMismatch.model, { operation: 'dialogue' }),
      'model_protocol.operation_not_supported',
    );

    const invalidEndpoint = providerFor(LIVE_TRANSLATE_MODEL);
    invalidEndpoint.baseUrl = 'not a URL';
    expectProtocolError(
      () => resolveRealtimeProfile(configWith(invalidEndpoint), invalidEndpoint.model),
      'model_protocol.endpoint_host_required',
    );
  });

  it('rejects DashScope wire dialects declared by non-DashScope providers', () => {
    const declarations: Array<(provider: ProviderDraft) => void> = [
      (provider) => {
        provider.localModelCapabilityRegistry = [{
          id: 'cross-kind-registry',
          modelId: provider.model,
          capabilities: ['speech-to-speech'],
          realtimeProtocol: 'dashscope-omni',
        }];
      },
      (provider) => {
        provider.templateRealtimeProtocol = 'dashscope-livetranslate';
      },
      (provider) => {
        provider.realtimeProtocol = 'dashscope-asr';
      },
    ];

    for (const declare of declarations) {
      const provider = providerFor('unregistered-alias', 'openai-compatible');
      declare(provider);
      expectProtocolError(
        () => resolveRealtimeProfile(configWith(provider), provider.model),
        'model_protocol.authorization_identity_mismatch',
      );
    }
  });

  it('rejects a newly enabled manifest dialect until the UI has an explicit route adapter', () => {
    const profile = MODEL_PROTOCOL_REGISTRY.profiles.find((candidate) => (
      candidate.exactModelIds.includes(OMNI_MODEL)
    ));
    if (!profile) throw new Error(`missing manifest profile for ${OMNI_MODEL}`);
    const originalAdapter = profile.adapter;
    profile.adapter = {
      status: 'enabled',
      adapterId: 'test-future-omni-adapter',
      reason: 'test-only future adapter registration',
    };
    try {
      expectProtocolError(
        () => resolveRealtimeProfile(configWith(providerFor(OMNI_MODEL)), OMNI_MODEL),
        'model_protocol.dialect_not_registered',
      );
    } finally {
      profile.adapter = originalAdapter;
    }
  });

  it('keeps first-entry duplicate diagnostics for non-DashScope providers', () => {
    const provider = providerFor('duplicate-alias', 'openai-compatible');
    provider.localModelCapabilityRegistry = [
      { id: 'first', modelId: provider.model, capabilities: ['speech-to-text'], realtimeProtocol: 'openai-transcription' },
      { id: 'second', modelId: provider.model, capabilities: ['speech-to-speech'], realtimeProtocol: 'openai-conversation' },
    ];
    const profile = resolveRealtimeProfile(configWith(provider), provider.model);
    expect(profile.protocolDialect).toBe('openai-transcription');
    expect(profile.diagnostics[0]).toContain("first entry 'first'");
  });

  it('preserves non-DashScope template, provider, and name fallback precedence', () => {
    const provider = providerFor('gpt-realtime-v2', 'openai-compatible');
    provider.templateRealtimeProtocol = 'openai-transcription';
    provider.realtimeProtocol = 'openai-translation';
    expect(resolveRealtimeProfile(configWith(provider), provider.model)).toMatchObject({
      protocolDialect: 'openai-transcription', source: 'template',
    });
    delete provider.templateRealtimeProtocol;
    expect(resolveRealtimeProfile(configWith(provider), provider.model)).toMatchObject({
      protocolDialect: 'openai-translation', source: 'provider',
    });
    delete provider.realtimeProtocol;
    expect(resolveRealtimeProfile(configWith(provider), provider.model)).toMatchObject({
      protocolDialect: 'openai-conversation', source: 'model-name',
    });
  });

  it('covers every non-DashScope explicit protocol for standard and unhinted aliases', () => {
    const matrix: Array<{
      protocol: RealtimeProtocol;
      standard: string;
      routeKind: string;
      sampleRate: number;
    }> = [
      { protocol: 'openai-conversation', standard: 'gpt-realtime', routeKind: 'openai-realtime', sampleRate: 24_000 },
      { protocol: 'openai-translation', standard: 'gpt-realtime-translate', routeKind: 'openai-realtime', sampleRate: 24_000 },
      { protocol: 'openai-transcription', standard: 'gpt-realtime-whisper', routeKind: 'openai-realtime', sampleRate: 24_000 },
      { protocol: 'openai-flat', standard: 'vendor-realtime-flat', routeKind: 'openai-realtime', sampleRate: 16_000 },
      { protocol: 'gemini-live', standard: 'gemini-2.5-flash-live', routeKind: 'gemini-live', sampleRate: 16_000 },
    ];

    for (const [index, row] of matrix.entries()) {
      for (const modelId of [row.standard, `deployment-${index}`]) {
        const provider = providerFor(modelId, 'openai-compatible');
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
            sampleRate: row.sampleRate,
            source: 'registry',
          });
        }
      }
    }
  });

  it('preserves non-DashScope OpenAI, Gemini, and local-vad name behavior', () => {
    const inferredProfile = (modelId: string, templateId: string) =>
      resolveRealtimeProfile(configWith(providerFor(modelId, 'openai-compatible', templateId)), modelId);

    expect(inferredProfile('gpt-translate-v2', 'template-custom')).toMatchObject({
      protocolDialect: 'openai-translation', nativeTranslation: true,
    });
    expect(inferredProfile('gpt-transcribe-v2', 'template-custom')).toMatchObject({
      protocolDialect: 'openai-transcription', realtimeAudioMode: 'server_vad',
    });
    expect(inferredProfile('gpt-whisper-v2', 'template-custom')).toMatchObject({
      protocolDialect: 'openai-transcription', realtimeAudioMode: 'manual',
    });
    expect(inferredProfile('gpt-realtime-v2', 'template-custom')).toMatchObject({
      protocolDialect: 'openai-conversation', nativeAudioOutput: true,
    });
    expect(inferredProfile('gpt-live-v2', 'template-custom')).toMatchObject({
      protocolDialect: 'openai-conversation', nativeAudioOutput: true,
    });
    for (const modelId of [
      'gemini-flash-live',
      'gemini-flash-realtime',
      'gemini-flash-native-audio',
    ]) {
      expect(inferredProfile(modelId, 'template-gemini')).toMatchObject({
        protocolDialect: 'gemini-live', routeKind: 'gemini-live', realtimeAudioMode: 'gemini_auto_activity',
      });
    }
    expect(inferredProfile('gemini-flash-live', 'template-custom')).toMatchObject({
      protocolDialect: 'openai-conversation', routeKind: 'openai-realtime',
    });
    expect(inferredProfile('plain-text-model', 'template-custom')).toMatchObject({
      protocolDialect: null, routeKind: 'local-vad', speechDispatchPolicy: 'subtitle-tts', source: 'none',
    });
  });

  it('binds a scene-assigned non-Bailian model to its explicit provider', () => {
    const provider = providerFor('default-text-model', 'openai-compatible');
    provider.sceneModelAssignments = [{
      scenario: 'watch',
      modelIds: ['gpt-live-scene'],
    }];
    expect(resolveRealtimeProfile(configWith(provider), 'gpt-live-scene')).toMatchObject({
      providerId: provider.providerId,
      protocolDialect: 'openai-conversation',
      routeKind: 'openai-realtime',
    });
  });

  it('keeps an exact non-DashScope entry without protocol as local-vad', () => {
    const provider = providerFor('same-capabilities', 'openai-compatible');
    provider.localModelCapabilityRegistry = [{
      id: 'other', modelId: provider.model, capabilities: ['speech-to-speech'],
      realtimeAudioMode: 'server_vad', interactionCapabilities: ['streaming'],
    }];
    expect(resolveRealtimeProfile(configWith(provider), provider.model)).toMatchObject({
      routeKind: 'local-vad', protocolDialect: null, source: 'registry',
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
