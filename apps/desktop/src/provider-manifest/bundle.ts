import bundleDocument from '../../../../contracts/provider-manifests.compiled.v1.json';

import { ProviderManifestRegistry } from './registry';
import type { ProviderManifest } from './types';

export type ProviderManifestBundle = {
  $schema: './provider-manifest-bundle.schema.json';
  schemaVersion: 'provider-manifest-bundle/v1';
  sources: Array<{
    providerId: string;
    path: string;
    manifestVersion: number;
    checkedAt: string;
    sha256: string;
  }>;
  manifests: ProviderManifest[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertProviderManifestBundle(value: unknown): asserts value is ProviderManifestBundle {
  if (!isRecord(value) || value.schemaVersion !== 'provider-manifest-bundle/v1') {
    throw new Error('Compiled provider manifest bundle has an unsupported schema version.');
  }
  if (!Array.isArray(value.sources) || !Array.isArray(value.manifests) || value.manifests.length === 0) {
    throw new Error('Compiled provider manifest bundle has no registry sources.');
  }
  for (const manifest of value.manifests) {
    if (
      !isRecord(manifest)
      || manifest.schemaVersion !== 'provider-manifest/v1'
      || !isRecord(manifest.provider)
      || typeof manifest.provider.id !== 'string'
      || !Array.isArray(manifest.models)
      || !Array.isArray(manifest.protocolProfiles)
    ) {
      throw new Error('Compiled provider manifest bundle contains an invalid manifest envelope.');
    }
  }
  for (const source of value.sources) {
    if (
      !isRecord(source)
      || typeof source.providerId !== 'string'
      || typeof source.manifestVersion !== 'number'
      || typeof source.checkedAt !== 'string'
      || typeof source.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(source.sha256)
    ) {
      throw new Error('Compiled provider manifest bundle contains invalid source authority.');
    }
    const manifest = value.manifests.find((candidate) => (
      isRecord(candidate.provider) && candidate.provider.id === source.providerId
    ));
    if (
      !manifest
      || manifest.manifestVersion !== source.manifestVersion
      || manifest.checkedAt !== source.checkedAt
    ) {
      throw new Error(`Compiled provider source '${source.providerId}' does not match its manifest.`);
    }
  }
}

const compiledBundle: unknown = bundleDocument;
assertProviderManifestBundle(compiledBundle);

export const PROVIDER_MANIFEST_BUNDLE = compiledBundle;
export const PROVIDER_MANIFEST_REGISTRY = new ProviderManifestRegistry(
  PROVIDER_MANIFEST_BUNDLE.manifests,
);
