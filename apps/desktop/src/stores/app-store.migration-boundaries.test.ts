import { describe, expect, it } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';
import type { AppConfigDraft, ProviderDraft } from '../schema/config';
import { appStoreTestHelpers } from './app-store';

function legacy() {
  const config = structuredClone(appConfigDraftMock);
  const devices: Partial<typeof config.devices> = { ...config.devices };
  delete devices.primaryTextTranslationModelId;
  config.devices = devices as typeof config.devices;
  config.devices.inboundVoiceModelId = 'template-dashscope-realtime::qwen3-asr-flash-realtime';
  config.devices.outboundVoiceModelId = '';
  config.devices.subtitleTranslationModelId = 'template-dashscope-realtime::qwen-plus';
  return config;
}
function boundText(config: AppConfigDraft): ProviderDraft {
  const provider = structuredClone(config.providers[0]);
  Object.assign(provider, { templateId: 'template-custom-text', providerId: 'custom-text', kind: 'openai-compatible', model: 'not-selected', baseUrl: 'https://example.com/v1', transport: 'streaming-http', localModelCapabilityRegistry: [], candidateModelGroups: [] });
  provider.modelProtocolBindings = [{ modelId: 'bound-text', operation: 'text-translation', profileOwnerProviderId: 'openai', manifestVersion: 3, profileId: 'openai.chat-completions.sse.ga', profileVersion: 1, authProfileId: 'openai.auth.bearer-header' }];
  config.providers.push(provider);
  config.devices.subtitleTranslationModelId = 'bound-text';
  return provider;
}

describe('legacy translator migration rejects ambiguous and malformed authority', () => {
  it.each(['template-dashscope-realtime::', 'template-dashscope-realtime:: qwen-plus', 'template-dashscope-realtime::qwen-plus '])('rejects empty/whitespace model identity %s without rewriting the document', (reference) => {
    const config = legacy();
    config.devices.subtitleTranslationModelId = reference;
    const before = structuredClone(config);
    expect(appStoreTestHelpers.migratePrimaryTextTranslationModel(config)).toBe('');
    expect(config).toEqual(before);
  });

  it('resolves a bare explicitly bound translator without a catalog/registry match, but rejects duplicate bindings', () => {
    const config = legacy();
    const provider = boundText(config);
    expect(appStoreTestHelpers.migratePrimaryTextTranslationModel(config)).toBe('bound-text');
    provider.modelProtocolBindings!.push({ ...provider.modelProtocolBindings![0] });
    expect(appStoreTestHelpers.migratePrimaryTextTranslationModel(config)).toBe('');
  });

  it('does not migrate a custom text operation with an unsupported auth scheme', () => {
    const config = legacy();
    const provider = boundText(config);
    provider.authRef.scheme = 'none';
    expect(appStoreTestHelpers.migratePrimaryTextTranslationModel(config)).toBe('');
  });

  it('requires a matching provider family for legacy Whisper, not only a model name', () => {
    const config = legacy();
    config.providers[0].model = 'whisper-1';
    config.devices.inboundVoiceModelId = `${config.providers[0].templateId}::whisper-1`;
    expect(appStoreTestHelpers.migratePrimaryTextTranslationModel(config)).toBe('');
    config.providers[0].kind = 'openai-compatible';
    expect(appStoreTestHelpers.migratePrimaryTextTranslationModel(config)).toBe(config.devices.subtitleTranslationModelId);
  });

  it('handles absent provider collection and missing legacy route references without authorizing a translator', () => {
    const noProviders = legacy();
    Reflect.deleteProperty(noProviders, 'providers');
    expect(appStoreTestHelpers.migratePrimaryTextTranslationModel(noProviders)).toBe('');
    const config = legacy();
    Reflect.deleteProperty(config.devices, 'inboundVoiceModelId');
    Reflect.deleteProperty(config.devices, 'outboundVoiceModelId');
    expect(appStoreTestHelpers.migratePrimaryTextTranslationModel(config)).toBe('');
  });
});
