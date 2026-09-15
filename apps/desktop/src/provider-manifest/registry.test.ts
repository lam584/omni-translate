import { describe, expect, it } from 'vitest';

import { ProviderManifestRegistry, ProviderManifestRegistryError } from './registry';
import type { ProviderManifest } from './types';

function minimalManifest(providerId: string, templateId: string, profileId = `${providerId}.profile`): ProviderManifest {
  return {
    provider: { id: providerId, templateId },
    protocolProfiles: [{ id: profileId, version: 1 }],
  } as ProviderManifest;
}

function expectCode(callback: () => unknown, code: ProviderManifestRegistryError['code']) {
  expect(callback).toThrowError(ProviderManifestRegistryError);
  try {
    callback();
  } catch (error) {
    expect((error as ProviderManifestRegistryError).code).toBe(code);
  }
}

describe('ProviderManifestRegistry', () => {
  it('indexes provider and template identities without model-name routing', () => {
    const manifest = minimalManifest('fixture-provider', 'template-fixture');
    const registry = new ProviderManifestRegistry([manifest]);
    expect(registry.findByProviderId('fixture-provider')).toBe(manifest);
    expect(registry.findByTemplateId('template-fixture')).toBe(manifest);
    expect(registry.findByProviderId('fixture-provider-realtime')).toBeNull();
  });

  it('rejects duplicate provider identities', () => {
    expectCode(() => new ProviderManifestRegistry([
      minimalManifest('fixture-provider', 'template-a'),
      minimalManifest('fixture-provider', 'template-b', 'fixture-provider.other'),
    ]), 'duplicate-provider-id');
  });

  it('rejects duplicate template identities', () => {
    expectCode(() => new ProviderManifestRegistry([
      minimalManifest('provider-a', 'template-fixture'),
      minimalManifest('provider-b', 'template-fixture'),
    ]), 'duplicate-template-id');
  });

  it('rejects a duplicate global profile id and version', () => {
    expectCode(() => new ProviderManifestRegistry([
      minimalManifest('provider-a', 'template-a', 'shared.profile'),
      minimalManifest('provider-b', 'template-b', 'shared.profile'),
    ]), 'duplicate-profile-version');
  });
});
