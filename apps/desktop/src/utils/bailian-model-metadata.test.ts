import { describe, expect, it } from 'vitest';
import { appConfigDraftMock } from '../defaults/app-config';
import type { ProviderCapability } from '../schema/provider-contract';
import { effectiveProviderModelRegistry } from './provider-model-capabilities-registry';
import {
  BAILIAN_METADATA_CACHE_TTL_MS,
  bailianMetadataForProvider,
  capabilitiesFromBailianMetadata,
  isBailianMetadataExpired,
} from './bailian-model-metadata';

const metadata = { modelId: 'qwen3.8-flash', categories: ['TG'], requestModalities: ['Text', 'Image'], responseModalities: ['Text'] };

describe('Bailian advisory metadata', () => {
  it('requires explicit category and corresponding input/output, not modality Cartesian products', () => {
    expect(capabilitiesFromBailianMetadata(metadata)).toEqual(['text-generation']);
    expect(capabilitiesFromBailianMetadata({ ...metadata, categories: ['Multimodal-Omni'] })).toEqual([]);
    expect(capabilitiesFromBailianMetadata({ ...metadata, requestModalities: ['Audio'] })).toEqual([]);
    expect(capabilitiesFromBailianMetadata({ ...metadata, categories: ['ASR'], requestModalities: ['Audio'] })).toEqual(['speech-to-text']);
  });

  it('uses refreshed exact-model data within 10-minute TTL, explicit user cancellation takes precedence', () => {
    const baseTime = 1_790_000_000_000;
    const freshFetchedAt = new Date(baseTime).toISOString();
    const provider = { ...appConfigDraftMock.providers.find((item) => item.kind === 'dashscope')!, modelMetadataCache: {
      source: 'bailian-api' as const, endpoint: 'https://dashscope.aliyuncs.com/api/v1/models', fetchedAt: freshFetchedAt, models: [metadata],
    } };
    expect(bailianMetadataForProvider(provider, baseTime)).toEqual([metadata]);
    expect(bailianMetadataForProvider(provider, baseTime + BAILIAN_METADATA_CACHE_TTL_MS - 1000)).toEqual([metadata]);
    expect(bailianMetadataForProvider({ ...provider, region: 'ap-southeast-1' }, baseTime)).toEqual([]);
    expect(bailianMetadataForProvider({ ...provider, baseUrl: 'wss://other.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime' }, baseTime)).toEqual([]);

    // Overrides still take precedence over fresh cache
    const freshProvider = { ...provider, modelMetadataCache: { ...provider.modelMetadataCache, fetchedAt: new Date().toISOString() } };
    expect(effectiveProviderModelRegistry(freshProvider).find((item) => item.modelId === metadata.modelId)?.capabilities).toContain('text-generation');
    const disabled = { ...freshProvider, modelCapabilityOverrides: [{ modelId: metadata.modelId, capabilities: [] as ProviderCapability[] }] };
    expect(effectiveProviderModelRegistry(disabled).find((item) => item.modelId === metadata.modelId)?.capabilities).toEqual([]);
  });

  it('expires cache after 10 minutes and avoids stale use in consumers', () => {
    const baseTime = 1_790_000_000_000;
    const fetchedAt = new Date(baseTime).toISOString();
    const cache = {
      source: 'bailian-api' as const,
      endpoint: 'https://dashscope.aliyuncs.com/api/v1/models',
      fetchedAt,
      models: [metadata],
    };

    expect(isBailianMetadataExpired(cache, baseTime)).toBe(false);
    expect(isBailianMetadataExpired(cache, baseTime + 9 * 60 * 1000)).toBe(false);
    expect(isBailianMetadataExpired(cache, baseTime + 10 * 60 * 1000)).toBe(true);
    expect(isBailianMetadataExpired(cache, baseTime + 11 * 60 * 1000)).toBe(true);
    expect(isBailianMetadataExpired(undefined, baseTime)).toBe(true);
    expect(isBailianMetadataExpired({ ...cache, fetchedAt: 'invalid-date' }, baseTime)).toBe(true);

    const provider = { ...appConfigDraftMock.providers.find((item) => item.kind === 'dashscope')!, modelMetadataCache: cache };
    // At 10 minutes or later, bailianMetadataForProvider treats the cache as expired and avoids stale use
    expect(bailianMetadataForProvider(provider, baseTime + 10 * 60 * 1000)).toEqual([]);
  });

  it('preserves explicit capability overrides even when cache is expired or absent', () => {
    const baseTime = 1_790_000_000_000;
    const expiredFetchedAt = new Date(baseTime - 20 * 60 * 1000).toISOString();
    const explicitCapabilities: ProviderCapability[] = ['text-generation', 'speech-to-text'];
    const provider = {
      ...appConfigDraftMock.providers.find((item) => item.kind === 'dashscope')!,
      modelMetadataCache: {
        source: 'bailian-api' as const,
        endpoint: 'https://dashscope.aliyuncs.com/api/v1/models',
        fetchedAt: expiredFetchedAt,
        models: [metadata],
      },
      modelCapabilityOverrides: [{ modelId: metadata.modelId, capabilities: explicitCapabilities }],
    };
    // Overridden capabilities remain intact despite expired cache
    const entry = effectiveProviderModelRegistry(provider).find((item) => item.modelId === metadata.modelId);
    expect(entry?.capabilities).toEqual(['text-generation', 'speech-to-text']);
  });

  it('does not apply Bailian metadata to unrelated providers', () => {
    const provider = { ...appConfigDraftMock.providers[0], kind: 'openai-compatible' as const, modelMetadataCache: {
      source: 'bailian-api' as const, endpoint: 'https://dashscope.aliyuncs.com/api/v1/models', fetchedAt: new Date().toISOString(), models: [metadata],
    } };
    expect(bailianMetadataForProvider(provider)).toEqual([]);
  });
});

