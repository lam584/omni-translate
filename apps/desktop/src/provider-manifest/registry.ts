import { resolveProviderProtocol } from './resolver';
import type { ProviderProtocolResolutionRequest } from './resolver';
import type { AuthorizedProviderProtocol, ProviderManifest } from './types';

export type ProviderManifestRegistryErrorCode =
  | 'duplicate-provider-id'
  | 'duplicate-template-id'
  | 'duplicate-profile-version';

export class ProviderManifestRegistryError extends Error {
  constructor(public readonly code: ProviderManifestRegistryErrorCode, message: string) {
    super(message);
    this.name = 'ProviderManifestRegistryError';
  }
}

export class ProviderManifestRegistry {
  private readonly manifests: ProviderManifest[];

  constructor(manifests: ProviderManifest[]) {
    const providerIds = new Set<string>();
    const templateIds = new Set<string>();
    const profileVersions = new Set<string>();

    for (const manifest of manifests) {
      const providerId = manifest.provider.id;
      if (providerIds.has(providerId)) {
        throw new ProviderManifestRegistryError(
          'duplicate-provider-id',
          `Provider manifest '${providerId}' is registered more than once.`,
        );
      }
      providerIds.add(providerId);

      const templateId = manifest.provider.templateId;
      if (templateIds.has(templateId)) {
        throw new ProviderManifestRegistryError(
          'duplicate-template-id',
          `Provider template '${templateId}' is registered more than once.`,
        );
      }
      templateIds.add(templateId);

      for (const profile of manifest.protocolProfiles) {
        const key = `${profile.id}@${profile.version}`;
        if (profileVersions.has(key)) {
          throw new ProviderManifestRegistryError(
            'duplicate-profile-version',
            `Provider protocol profile '${key}' is registered more than once.`,
          );
        }
        profileVersions.add(key);
      }
    }

    this.manifests = [...manifests];
  }

  all(): readonly ProviderManifest[] {
    return this.manifests;
  }

  findByProviderId(providerId: string): ProviderManifest | null {
    return this.manifests.find((manifest) => manifest.provider.id === providerId) ?? null;
  }

  findByTemplateId(templateId: string): ProviderManifest | null {
    return this.manifests.find((manifest) => manifest.provider.templateId === templateId) ?? null;
  }

  resolve(request: ProviderProtocolResolutionRequest): AuthorizedProviderProtocol {
    return resolveProviderProtocol(this.manifests, request);
  }
}
