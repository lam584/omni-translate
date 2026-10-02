import { describe, expect, it } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';
import { bailianMetadataForProvider, capabilitiesFromBailianMetadata } from './bailian-model-metadata';
const now = Date.parse('2026-10-02T00:00:00Z');
const row = { modelId: 'exact-id', categories: [], requestModalities: [], responseModalities: [] };

describe('advisory metadata trust boundaries', () => {
  it.each([
    ['Realtime-ASR', 'Audio', 'Text', 'speech-to-text'],
    ['TTS', 'Text', 'Audio', 'text-to-speech'],
    ['Realtime-Text-to-Speech', 'Text', 'Audio', 'text-to-speech'],
    ['Realtime-Audio-Translate', 'Audio', 'Audio', 'speech-to-speech'],
    ['Realtime-Omni', 'Audio', 'Audio', 'speech-to-speech'],
    ['Realtime-Chatting', 'Audio', 'Audio', 'speech-to-speech'],
  ])('requires both modalities for %s', (category, input, output, capability) => {
    const metadata = { ...row, categories: [category], requestModalities: [input], responseModalities: [output] };
    expect(capabilitiesFromBailianMetadata(metadata)).toEqual([capability]);
    expect(capabilitiesFromBailianMetadata({ ...metadata, requestModalities: [] })).toEqual([]);
    expect(capabilitiesFromBailianMetadata({ ...metadata, responseModalities: [] })).toEqual([]);
  });

  it.each(['dashscope-intl.aliyuncs.com', 'workspace.ap-southeast-1.maas.aliyuncs.com'])('accepts a matching Singapore endpoint %s only on the models path', (host) => {
    const provider = structuredClone(appConfigDraftMock.providers.find((p) => p.kind === 'dashscope')!);
    provider.region = 'ap-southeast-1';
    provider.baseUrl = `wss://${host}/api-ws/v1/realtime`;
    provider.modelMetadataCache = { source: 'bailian-api', fetchedAt: new Date(now).toISOString(), endpoint: `https://${host}/api/v1/models`, models: [row] };
    expect(bailianMetadataForProvider(provider, now)).toEqual([row]);
    provider.modelMetadataCache.endpoint = `https://${host}/api/v1/other`;
    expect(bailianMetadataForProvider(provider, now)).toEqual([]);
    provider.modelMetadataCache.endpoint = undefined;
    expect(bailianMetadataForProvider(provider, now)).toEqual([]);
  });

  it('fails closed for an unknown region, and malformed URLs do not establish cache authority', () => {
    const provider = structuredClone(appConfigDraftMock.providers.find((p) => p.kind === 'dashscope')!);
    provider.region = 'global';
    provider.modelMetadataCache = { source: 'bailian-api', fetchedAt: new Date(now).toISOString(), endpoint: 'https://dashscope.aliyuncs.com/api/v1/models', models: [row] };
    expect(bailianMetadataForProvider(provider, now)).toEqual([]);
    provider.baseUrl = 'not a URL';
    expect(bailianMetadataForProvider(provider, now)).toEqual([]);
    provider.region = undefined;
    expect(bailianMetadataForProvider(provider, now)).toEqual([]);
    provider.baseUrl = 'https://dashscope.aliyuncs.com';
    const inferred = bailianMetadataForProvider(provider, now);
    expect(inferred).not.toContainEqual(row);
    expect(inferred).toEqual([]);
  });
});
