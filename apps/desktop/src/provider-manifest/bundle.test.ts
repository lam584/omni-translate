import { describe, expect, it } from 'vitest';

import { ProviderProtocolResolutionError } from './resolver';
import { PROVIDER_MANIFEST_BUNDLE, PROVIDER_MANIFEST_REGISTRY } from './bundle';

describe('compiled provider manifest bundle', () => {
  it('loads one deterministic registry entry for every first-batch provider', () => {
    expect(PROVIDER_MANIFEST_BUNDLE.schemaVersion).toBe('provider-manifest-bundle/v1');
    expect(PROVIDER_MANIFEST_BUNDLE.sources.map((source) => source.providerId)).toEqual([
      'azure-openai',
      'google-gemini',
      'openai',
      'tencent-cloud',
      'volcengine-doubao',
      'zhipu-glm',
    ]);
    expect(PROVIDER_MANIFEST_REGISTRY.all()).toHaveLength(6);
  });

  it('indexes exact provider and template identities from the same generated source', () => {
    const openai = PROVIDER_MANIFEST_REGISTRY.findByProviderId('openai');
    expect(openai?.provider.templateId).toBe('template-openai-compatible-realtime');
    expect(PROVIDER_MANIFEST_REGISTRY.findByTemplateId('template-openai-compatible-realtime')).toBe(openai);
    expect(PROVIDER_MANIFEST_REGISTRY.findByProviderId('openai-realtime')).toBeNull();
  });

  it('does not authorize an unknown realtime-looking model name', () => {
    expect(() => PROVIDER_MANIFEST_REGISTRY.resolve({
      providerId: 'openai',
      modelId: 'gpt-realtime-future-guess',
      operation: 'realtime-conversation',
    })).toThrowError(ProviderProtocolResolutionError);
  });
});
