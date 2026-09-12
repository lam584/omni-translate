import type { ProviderModelProtocolBinding } from '../schema/config';
import type { ProviderAuthScheme, ProviderKind, ProviderTransport } from '../schema/provider-contract';

import { PROVIDER_MANIFEST_REGISTRY } from './bundle';
import type {
  ProviderManifest,
  ProviderManifestAuthProfile,
  ProviderManifestOperation,
  ProviderManifestProtocolProfile,
} from './types';

export type CustomProviderProtocolProfileOption = {
  key: string;
  label: string;
  profileOwnerProviderId: string;
  manifestVersion: number;
  profileId: string;
  profileVersion: number;
  operation: ProviderManifestOperation;
  transport: ProviderTransport;
  authProfileId: string;
  authHeaderName: string;
  authScheme: ProviderAuthScheme;
  verification: ProviderManifestProtocolProfile['adapter']['verification'];
};

function providerTransport(kind: string): ProviderTransport | null {
  if (kind === 'sse') return 'streaming-http';
  if (kind === 'websocket') return 'websocket';
  if (kind === 'http') return 'http';
  return null;
}

function credentialHeader(auth: ProviderManifestAuthProfile) {
  return auth.parameters.find((parameter) => (
    parameter.location === 'header'
    && parameter.source === 'credential'
    && parameter.required
  ));
}

function authScheme(auth: ProviderManifestAuthProfile): ProviderAuthScheme {
  const header = credentialHeader(auth);
  return header?.scheme?.toLowerCase() === 'bearer' || auth.type === 'bearer'
    ? 'bearer'
    : 'api-key';
}

function selectableOperations(profile: ProviderManifestProtocolProfile): ProviderManifestOperation[] {
  // The current custom-provider consumers invoke text translation and realtime
  // conversation. A profile may advertise broader operations, but the UI only
  // offers operations with a production adapter call site.
  return profile.operations.filter((operation) => (
    operation === 'text-translation' || operation === 'realtime-conversation'
  ));
}

function optionFor(
  manifest: ProviderManifest,
  profile: ProviderManifestProtocolProfile,
  operation: ProviderManifestOperation,
): CustomProviderProtocolProfileOption | null {
  const transport = manifest.transports.find((candidate) => candidate.id === profile.transportId);
  const auth = manifest.authProfiles.find((candidate) => candidate.id === profile.defaultAuthProfileId);
  const runtimeTransport = transport ? providerTransport(transport.kind) : null;
  const header = auth ? credentialHeader(auth) : undefined;
  if (!runtimeTransport || !auth || !header) return null;

  const key = JSON.stringify([
    manifest.provider.id,
    manifest.manifestVersion,
    profile.id,
    profile.version,
    operation,
  ]);
  return {
    key,
    label: `${manifest.provider.displayName} · ${profile.id}@${profile.version} · ${operation}${profile.adapter.verification === 'fixture-only' ? ' · fixture-only（无 live 证据）' : ''}`,
    profileOwnerProviderId: manifest.provider.id,
    manifestVersion: manifest.manifestVersion,
    profileId: profile.id,
    profileVersion: profile.version,
    operation,
    transport: runtimeTransport,
    authProfileId: auth.id,
    authHeaderName: header.name,
    authScheme: authScheme(auth),
    verification: profile.adapter.verification,
  };
}

const EXPLICIT_CUSTOM_PROFILE_OPTIONS = PROVIDER_MANIFEST_REGISTRY.all().flatMap((manifest) => (
  manifest.protocolProfiles.flatMap((profile) => {
    if (
      profile.customProviderPolicy !== 'explicit-profile'
      || profile.customEndpointPolicy !== 'absolute-secure-url-no-userinfo'
      || profile.adapter.status !== 'enabled'
      || profile.adapter.verification === 'not-implemented'
    ) return [];
    const family = manifest.apiFamilies.find((candidate) => candidate.id === profile.apiFamilyId);
    if (!family || family.endpointStatus !== 'verified' || family.endpointTemplate === null) return [];
    return selectableOperations(profile)
      .map((operation) => optionFor(manifest, profile, operation))
      .filter((option): option is CustomProviderProtocolProfileOption => option !== null);
  })
));

export function customProviderProtocolProfileOptions(
  kind: ProviderKind,
): readonly CustomProviderProtocolProfileOption[] {
  // DashScope native protocols are not semantically interchangeable with the
  // explicitly reusable OpenAI-compatible profiles.
  return kind === 'dashscope' ? [] : EXPLICIT_CUSTOM_PROFILE_OPTIONS;
}

export function customProviderProfileOptionForLegacyProtocol(
  kind: ProviderKind,
  legacyProtocolId: string,
): CustomProviderProtocolProfileOption | null {
  const normalized = legacyProtocolId.trim();
  if (!normalized) return null;
  const matches = customProviderProtocolProfileOptions(kind).filter((option) => {
    const owner = PROVIDER_MANIFEST_REGISTRY.findByProviderId(option.profileOwnerProviderId);
    const profile = owner?.protocolProfiles.find((candidate) => (
      candidate.id === option.profileId && candidate.version === option.profileVersion
    ));
    return profile?.legacyProtocolIds?.includes(normalized) === true;
  });
  return matches.length === 1 ? matches[0] : null;
}

export function resolveCustomProviderProtocolProfileOption(
  kind: ProviderKind,
  key: string,
): CustomProviderProtocolProfileOption | null {
  return customProviderProtocolProfileOptions(kind).find((option) => option.key === key) ?? null;
}

export function customProviderBinding(
  kind: ProviderKind,
  key: string,
  modelId: string,
): ProviderModelProtocolBinding | null {
  const option = resolveCustomProviderProtocolProfileOption(kind, key);
  if (!option || !modelId.trim()) return null;
  return {
    modelId: modelId.trim(),
    operation: option.operation,
    profileOwnerProviderId: option.profileOwnerProviderId,
    manifestVersion: option.manifestVersion,
    profileId: option.profileId,
    profileVersion: option.profileVersion,
    authProfileId: option.authProfileId,
  };
}

export function customProviderProfileKeyFromBinding(
  binding: ProviderModelProtocolBinding | undefined,
): string {
  if (!binding) return '';
  return JSON.stringify([
    binding.profileOwnerProviderId,
    binding.manifestVersion,
    binding.profileId,
    binding.profileVersion,
    binding.operation,
  ]);
}
