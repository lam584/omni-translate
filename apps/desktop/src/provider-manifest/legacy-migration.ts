import type { ProviderDraft } from '../schema/config';

import { PROVIDER_MANIFEST_REGISTRY } from './bundle';
import { protocolBindingsForTemplate } from './template-projection';
import type { ProviderManifest, ProviderManifestOperation } from './types';

export type LegacyProviderProtocolInput = {
  providerId: string;
  templateId?: string;
  modelId: string;
  legacyProtocolId?: string;
};

export type MigratedProviderProtocolBinding = {
  profileId: string;
  profileVersion: number;
  source: 'exact-model' | 'legacy-protocol-id';
};

/**
 * Converts persisted pre-manifest configuration into an explicit versioned
 * profile. Runtime connection paths must use resolveProviderProtocol instead.
 */
export function migrateLegacyProviderProtocolBinding(
  manifests: ProviderManifest[],
  input: LegacyProviderProtocolInput,
  operation: ProviderManifestOperation,
): MigratedProviderProtocolBinding | null {
  const manifest = manifests.find((candidate) => (
    candidate.provider.id === input.providerId
    || candidate.provider.templateId === input.templateId
  ));
  if (manifest) {
    const normalizedModelId = input.modelId.trim().toLowerCase();
    const model = manifest.models.find((candidate) => (
      candidate.id.trim().toLowerCase() === normalizedModelId
      || candidate.aliases?.some((alias) => alias.trim().toLowerCase() === normalizedModelId)
    ));
    const binding = model?.protocolBindings.find((candidate) => candidate.operation === operation);
    const profile = binding
      ? manifest.protocolProfiles.find((candidate) => (
        candidate.id === binding.protocolProfileId
        && candidate.version === binding.protocolProfileVersion
      ))
      : null;
    if (profile) {
      return { profileId: profile.id, profileVersion: profile.version, source: 'exact-model' };
    }
  }

  const legacyProtocolId = input.legacyProtocolId?.trim();
  if (!legacyProtocolId) return null;
  const matches = manifests.flatMap((candidate) => candidate.protocolProfiles
    .filter((profile) => (
      profile.operations.includes(operation)
      && profile.legacyProtocolIds?.includes(legacyProtocolId)
    ))
    .map((profile) => ({ manifest: candidate, profile })));
  const providerMatches = matches.filter(({ manifest: candidate }) => (
    candidate.provider.id === input.providerId
    || candidate.provider.templateId === input.templateId
  ));
  const effective = providerMatches.length > 0 ? providerMatches : matches;
  if (effective.length !== 1) return null;
  return {
    profileId: effective[0].profile.id,
    profileVersion: effective[0].profile.version,
    source: 'legacy-protocol-id',
  };
}

/**
 * Adds manifest authority to pre-manifest built-in provider drafts while they
 * are being loaded. The immutable template id is the migration key; runtime
 * connection code must never call this helper or infer authority from a model
 * name. Custom providers deliberately remain unbound when their old config
 * does not identify one unique profile, so they fail closed before connect.
 */
export function hydrateLegacyProviderManifestAuthority(provider: ProviderDraft): ProviderDraft {
  const manifest = PROVIDER_MANIFEST_REGISTRY.findByTemplateId(provider.templateId);
  if (!manifest) return provider;

  const bindings = provider.modelProtocolBindings;
  const normalizedModelId = provider.model.trim().toLowerCase();
  const canonicalCandidates = manifest.models.filter((model) => (
    model.id.trim().toLowerCase() === normalizedModelId
    || model.aliases?.some((alias) => alias.trim().toLowerCase() === normalizedModelId)
  ));
  // Alias interpretation is restricted to this one-time migration boundary.
  // Ambiguous aliases remain untouched so runtime authorization fails closed.
  const canonicalModelId = canonicalCandidates.length === 1
    ? canonicalCandidates[0].id
    : provider.model;
  return {
    ...provider,
    model: canonicalModelId,
    manifestProviderId: manifest.provider.id,
    modelProtocolBindings: bindings && bindings.length > 0
      ? bindings
      : protocolBindingsForTemplate(provider.templateId),
  };
}
