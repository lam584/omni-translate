import { describe, expect, it } from 'vitest';

import type { ProviderDraft } from '../schema/config';
import { hydrateLegacyProviderManifestAuthority } from './legacy-migration';

function legacyVolcDraft(model: string): ProviderDraft {
  return {
    templateId: 'template-volcengine-doubao',
    model,
  } as ProviderDraft;
}

describe('legacy provider manifest hydration', () => {
  it('canonicalizes one unique built-in alias only at migration time', () => {
    const hydrated = hydrateLegacyProviderManifestAuthority(
      legacyVolcDraft('doubao-seed-2-0-lite-260215'),
    );
    expect(hydrated.model).toBe('doubao-seed-2-0-lite-260428');
    expect(hydrated.manifestProviderId).toBe('volcengine-doubao');
    expect(hydrated.modelProtocolBindings?.length).toBeGreaterThan(0);
  });

  it('does not guess when a legacy alias maps to multiple exact models', () => {
    const hydrated = hydrateLegacyProviderManifestAuthority(legacyVolcDraft('bigmodel'));
    expect(hydrated.model).toBe('bigmodel');
  });
});

import { appConfigDraftMock } from '../defaults/app-config';
it('does not canonicalize v2 exact IDs or persist inherited module bindings', () => {
  const provider = {...appConfigDraftMock.providers[0], model: 'QWEN3.5-LIVETRANSLATE-FLASH-REALTIME'};
  const hydrated = hydrateLegacyProviderManifestAuthority(provider);
  expect(hydrated.model).toBe(provider.model);
  expect(hydrated.modelProtocolBindings).toEqual([]);
});


it('hydrates Workspace ownership without replacing its connection settings, candidates or explicit bindings', () => {
  const provider: ProviderDraft = {
    ...structuredClone(appConfigDraftMock.providers[0]!),
    templateId: 'template-dashscope-workspace',
    manifestProviderId: undefined,
    modelRegistryVersion: 2,
    model: 'qwen3.8-livetranslate-flash-realtime',
    baseUrl: 'wss://workspace-test.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',
    modelProtocolBindings: [{
      modelId: 'qwen3.8-livetranslate-flash-realtime', operation: 'realtime-translation',
      profileOwnerProviderId: 'bailian', manifestVersion: 1,
      profileId: 'bailian.livetranslate.3_8.realtime.ws', profileVersion: 1,
    }],
    candidateModelGroups: [{ group: 'realtime-multimodal', modelIds: ['qwen3.8-livetranslate-flash-realtime'] }],
  };
  const original = structuredClone(provider);
  const hydrated = hydrateLegacyProviderManifestAuthority(provider);
  expect(hydrated.manifestProviderId).toBe('bailian');
  expect({ ...hydrated, manifestProviderId: original.manifestProviderId }).toEqual(original);
  expect(provider).toEqual(original);
});
