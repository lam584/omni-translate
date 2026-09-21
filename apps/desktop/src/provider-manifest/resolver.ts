import { authorizeModelProtocolInvocation, lookupModelProtocolProfiles, MODEL_PROTOCOL_REGISTRY, type ModelProtocolOperation, type ModelProtocolRegion, type ModelProtocolTransport } from '../model-protocol/profile-registry';
import type {
  AuthorizedProviderProtocol,
  ProviderManifest,
  ProviderManifestOperation,
  ProviderManifestProtocolProfile,
} from './types';

export type ProviderProtocolResolutionRequest = {
  /** Runtime provider instance identity persisted by the application. */
  providerId: string;
  /** Immutable template provenance used to derive the manifest owner. */
  templateId?: string;
  modelId: string;
  deploymentId?: string;
  operation: ProviderManifestOperation;
  declaredProfileId?: string;
  declaredProfileVersion?: number;
  declaredManifestVersion?: number;
  declaredAuthProfileId?: string;
  baseUrl?: string;
  transport?: 'http' | 'streaming-http' | 'websocket' | 'webrtc';
  authHeaderName?: string;
  authScheme?: 'bearer' | 'api-key';
  customProvider?: boolean;
  modelRegistryVersion?: number;
  region?: string;
};

export type ProviderProtocolResolutionErrorCode =
  | 'provider-manifest-not-found'
  | 'provider-template-not-found'
  | 'provider-owner-mismatch'
  | 'model-not-found'
  | 'model-operation-not-bound'
  | 'protocol-profile-required'
  | 'protocol-profile-not-found'
  | 'protocol-profile-version-mismatch'
  | 'provider-manifest-version-mismatch'
  | 'protocol-profile-model-mismatch'
  | 'protocol-profile-operation-mismatch'
  | 'protocol-adapter-unavailable'
  | 'custom-provider-profile-forbidden'
  | 'auth-profile-not-allowed'
  | 'deployment-id-required'
  | 'api-family-unresolved'
  | 'custom-endpoint-invalid'
  | 'transport-mismatch'
  | 'auth-shape-mismatch'
  | 'provider-manifest-invalid'
  | 'bailian-protocol-rejected';

export class ProviderProtocolResolutionError extends Error {
  constructor(public readonly code: ProviderProtocolResolutionErrorCode, message: string) {
    super(message);
    this.name = 'ProviderProtocolResolutionError';
  }
}

function requiredById<T extends { id: string }>(items: T[], id: string, label: string): T {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) {
    throw new ProviderProtocolResolutionError(
      'provider-manifest-invalid',
      `Provider manifest references missing ${label} '${id}'.`,
    );
  }
  return item;
}

function findProfile(manifests: ProviderManifest[], profileId: string, profileVersion: number): {
  manifest: ProviderManifest;
  profile: ProviderManifestProtocolProfile;
} | null {
  for (const manifest of manifests) {
    const profile = manifest.protocolProfiles.find((candidate) => (
      candidate.id === profileId && candidate.version === profileVersion
    ));
    if (profile) return { manifest, profile };
  }
  return null;
}

function authorize(
  manifest: ProviderManifest,
  runtimeProviderId: string,
  modelId: string,
  operation: ProviderManifestOperation,
  profile: ProviderManifestProtocolProfile,
  request: ProviderProtocolResolutionRequest,
  declaredVersion?: number,
): AuthorizedProviderProtocol {
  if (declaredVersion !== undefined && profile.version !== declaredVersion) {
    throw new ProviderProtocolResolutionError(
      'protocol-profile-version-mismatch',
      `Protocol profile '${profile.id}' is version ${profile.version}, not ${declaredVersion}.`,
    );
  }
  if (!profile.operations.includes(operation)) {
    throw new ProviderProtocolResolutionError(
      'protocol-profile-operation-mismatch',
      `Protocol profile '${profile.id}' does not support operation '${operation}'.`,
    );
  }
  if (profile.adapter.status !== 'enabled') {
    throw new ProviderProtocolResolutionError(
      'protocol-adapter-unavailable',
      `Protocol profile '${profile.id}' has no enabled runtime adapter.`,
    );
  }

  const apiFamily = requiredById(manifest.apiFamilies, profile.apiFamilyId, 'API family');
  if (apiFamily.endpointStatus !== 'verified' || apiFamily.endpointTemplate === null) {
    throw new ProviderProtocolResolutionError(
      'api-family-unresolved',
      `API family '${apiFamily.id}' is not an active verified endpoint.`,
    );
  }
  if (
    (apiFamily.modelAddressing === 'deployment-id' || apiFamily.modelAddressing === 'path-deployment')
    && !request.deploymentId?.trim()
  ) {
    throw new ProviderProtocolResolutionError(
      'deployment-id-required',
      `API family '${apiFamily.id}' requires an explicit deployment id separate from model id.`,
    );
  }
  const selectedAuthProfileId = request.declaredAuthProfileId ?? profile.defaultAuthProfileId;
  if (!profile.authProfileIds.includes(selectedAuthProfileId)) {
    throw new ProviderProtocolResolutionError(
      'auth-profile-not-allowed',
      `Protocol profile '${profile.id}' does not allow auth profile '${selectedAuthProfileId}'.`,
    );
  }

  if (manifest.provider.id === 'bailian') validateBailianSelection(profile, request);
  return {
    manifestVersion: manifest.manifestVersion,
    providerId: runtimeProviderId,
    profileOwnerProviderId: manifest.provider.id,
    modelId,
    deploymentId: request.deploymentId?.trim() || null,
    operation,
    protocolProfile: profile,
    apiFamily,
    transport: requiredById(manifest.transports, profile.transportId, 'transport'),
    authProfile: requiredById(manifest.authProfiles, selectedAuthProfileId, 'auth profile'),
    audioProfile: profile.audioProfileId
      ? requiredById(manifest.audioProfiles, profile.audioProfileId, 'audio profile')
      : null,
    lifecycleProfile: requiredById(manifest.lifecycleProfiles, profile.lifecycleProfileId, 'lifecycle profile'),
  };
}

function expectedProviderTransport(kind: string) {
  if (kind === 'sse') return 'streaming-http';
  if (kind === 'http' || kind === 'websocket' || kind === 'webrtc') return kind;
  return null;
}

function validateCustomConnectionShape(
  manifest: ProviderManifest,
  profile: ProviderManifestProtocolProfile,
  request: ProviderProtocolResolutionRequest,
) {
  if (profile.customEndpointPolicy !== 'absolute-secure-url-no-userinfo' || !request.baseUrl) {
    throw new ProviderProtocolResolutionError(
      'custom-endpoint-invalid',
      `Protocol profile '${profile.id}' has no authorized custom endpoint policy or endpoint.`,
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(request.baseUrl);
  } catch {
    throw new ProviderProtocolResolutionError('custom-endpoint-invalid', 'Custom endpoint must be an absolute URL.');
  }
  const transport = requiredById(manifest.transports, profile.transportId, 'transport');
  const allowedSchemes = transport.kind === 'websocket' ? ['https:', 'wss:'] : ['https:'];
  if (
    !allowedSchemes.includes(endpoint.protocol)
    || !endpoint.hostname
    || endpoint.username
    || endpoint.password
    || endpoint.hash
  ) {
    throw new ProviderProtocolResolutionError(
      'custom-endpoint-invalid',
      'Custom endpoint must use an authorized secure scheme and cannot contain userinfo or a fragment.',
    );
  }
  const expectedTransport = expectedProviderTransport(transport.kind);
  if (!expectedTransport || request.transport !== expectedTransport) {
    throw new ProviderProtocolResolutionError(
      'transport-mismatch',
      `Protocol profile '${profile.id}' requires transport '${expectedTransport}'.`,
    );
  }
  const authId = request.declaredAuthProfileId ?? profile.defaultAuthProfileId;
  const auth = requiredById(manifest.authProfiles, authId, 'auth profile');
  const header = auth.parameters.find((parameter) => (
    parameter.location === 'header' && parameter.source === 'credential' && parameter.required
  ));
  const expectedScheme = header?.scheme?.toLowerCase() === 'bearer' || auth.type === 'bearer'
    ? 'bearer'
    : 'api-key';
  if (!header || request.authHeaderName?.toLowerCase() !== header.name.toLowerCase() || request.authScheme !== expectedScheme) {
    throw new ProviderProtocolResolutionError(
      'auth-shape-mismatch',
      `Protocol profile '${profile.id}' requires its declared credential header and scheme.`,
    );
  }
}

function validateBailianSelection(profile: ProviderManifestProtocolProfile, request: ProviderProtocolResolutionRequest) {
  // Consume the same generated, lossless Bailian authority as runtime preflight.
  const operations: Partial<Record<ProviderManifestOperation, ModelProtocolOperation>> = {
    'realtime-translation': 'native_translate', 'realtime-conversation': 'dialogue',
    'realtime-transcription': 'asr', asr: 'asr', tts: 'tts', 'voice-clone': 'voice_clone',
  };
  const operation = operations[request.operation];
  const selected = MODEL_PROTOCOL_REGISTRY.profiles.find((candidate) => candidate.profileId === profile.id && candidate.profileVersion === profile.version);
  if (!operation || !selected) throw new ProviderProtocolResolutionError('bailian-protocol-rejected', 'model_protocol.profile_id_mismatch');
  let endpoint: URL;
  try {
    endpoint = new URL(request.baseUrl ?? '');
    if (!['https:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash || endpoint.search || endpoint.port) throw new Error('endpoint');
    const dialect = MODEL_PROTOCOL_REGISTRY.dialects.find((candidate) => candidate.dialectId === selected.dialectId);
    if (!['', '/', '/api/v1', '/compatible-mode/v1', dialect?.endpointPath].includes(endpoint.pathname.replace(/\/$/, '') || '/')) throw new Error('path');
  } catch { throw new ProviderProtocolResolutionError('custom-endpoint-invalid', 'Invalid Bailian endpoint.'); }
  const known = lookupModelProtocolProfiles(request.modelId).length > 0;
  if (!known && request.modelRegistryVersion !== 2) throw new ProviderProtocolResolutionError('model-not-found', 'Explicit v2 binding required.');
  const result = authorizeModelProtocolInvocation({ exactModelId: request.modelId, operation,
    transport: request.transport as ModelProtocolTransport, region: request.region as ModelProtocolRegion,
    endpointHost: endpoint.hostname, declaredProfileId: profile.id, declaredProfileVersion: profile.version,
  }, known ? MODEL_PROTOCOL_REGISTRY : { ...MODEL_PROTOCOL_REGISTRY, profiles: [{ ...selected, exactModelIds: [request.modelId] }] });
  if (!result.ok) throw new ProviderProtocolResolutionError('bailian-protocol-rejected', result.message ? `${result.errorCode}: ${result.message}` : result.errorCode);
}

function validateExplicitBuiltinEndpoint(manifest: ProviderManifest, profile: ProviderManifestProtocolProfile, request: ProviderProtocolResolutionRequest) {
  if (manifest.provider.id === 'bailian') { validateBailianSelection(profile, request); return; }
  const family = requiredById(manifest.apiFamilies, profile.apiFamilyId, 'API family');
  const transport = requiredById(manifest.transports, profile.transportId, 'transport');
  if (request.transport !== expectedProviderTransport(transport.kind)) {
    throw new ProviderProtocolResolutionError('transport-mismatch', 'Explicit binding cannot change transport.');
  }
  try {
    const actual = new URL(request.baseUrl ?? '');
    const base = new URL(family.baseUrlTemplate);
    const endpoint = family.endpointTemplate ? new URL(family.endpointTemplate, base) : base;
    const sameOrigin = actual.hostname === base.hostname && actual.port === base.port
      && (actual.protocol === base.protocol || (transport.kind === 'websocket' && actual.protocol === 'wss:' && base.protocol === 'https:'));
    const path = actual.pathname.replace(/\/$/, '');
    if (!sameOrigin || actual.username || actual.password || actual.hash || actual.search
      || ![base.pathname.replace(/\/$/, ''), endpoint.pathname.replace(/\/$/, '')].includes(path)) throw new Error('endpoint');
  } catch {
    throw new ProviderProtocolResolutionError('custom-endpoint-invalid', 'Explicit binding must retain its registered endpoint.');
  }
}

export function resolveProviderProtocol(
  manifests: ProviderManifest[],
  request: ProviderProtocolResolutionRequest,
): AuthorizedProviderProtocol {
  if (!request.modelId || request.modelId !== request.modelId.trim()) throw new ProviderProtocolResolutionError('model-not-found', 'An exact non-empty model ID is required.');
  // Custom instances never enter the built-in owner path, even if their
  // persisted template id happens to name a registered provider. Reuse is
  // authorized only by the selected profile's explicit custom policy.
  if (request.customProvider) {
    if (
      !request.declaredProfileId
      || request.declaredProfileVersion === undefined
      || request.declaredManifestVersion === undefined
    ) {
      throw new ProviderProtocolResolutionError(
        'protocol-profile-required',
        'A custom provider must explicitly select a protocol profile id and version.',
      );
    }
    const declared = findProfile(manifests, request.declaredProfileId, request.declaredProfileVersion);
    if (!declared) {
      throw new ProviderProtocolResolutionError(
        'protocol-profile-not-found',
        `Declared protocol profile '${request.declaredProfileId}' is not registered.`,
      );
    }
    if (declared.manifest.manifestVersion !== request.declaredManifestVersion) {
      throw new ProviderProtocolResolutionError(
        'provider-manifest-version-mismatch',
        `Protocol profile '${declared.profile.id}' belongs to manifest version ${declared.manifest.manifestVersion}, not ${request.declaredManifestVersion}.`,
      );
    }
    if (declared.profile.customProviderPolicy !== 'explicit-profile') {
      throw new ProviderProtocolResolutionError(
        'custom-provider-profile-forbidden',
        `Protocol profile '${declared.profile.id}' does not allow custom provider reuse.`,
      );
    }
    validateCustomConnectionShape(declared.manifest, declared.profile, request);
    return authorize(
      declared.manifest,
      request.providerId,
      request.modelId,
      request.operation,
      declared.profile,
      request,
      request.declaredProfileVersion,
    );
  }

  const manifest = request.templateId
    ? manifests.find((candidate) => candidate.provider.templateId === request.templateId)
    : manifests.find((candidate) => candidate.provider.id === request.providerId);
  if (!manifest) {
    throw new ProviderProtocolResolutionError(
      request.templateId ? 'provider-template-not-found' : 'provider-manifest-not-found',
      request.templateId
        ? `No provider manifest owns template '${request.templateId}'.`
        : `No provider manifest is registered for '${request.providerId}'.`,
    );
  }
  const canonicalRuntimeOwner = manifests.find((candidate) => (
    candidate.provider.id === request.providerId
  ));
  if (canonicalRuntimeOwner && canonicalRuntimeOwner.provider.id !== manifest.provider.id) {
    throw new ProviderProtocolResolutionError(
      'provider-owner-mismatch',
      `Provider '${request.providerId}' belongs to '${canonicalRuntimeOwner.provider.templateId}', not '${request.templateId}'.`,
    );
  }

  const model = manifest.models.find((candidate) => candidate.id === request.modelId);
  if (!model && request.modelRegistryVersion === 2 && request.declaredProfileId
    && request.declaredProfileVersion !== undefined && request.declaredManifestVersion !== undefined) {
    if (manifest.manifestVersion !== request.declaredManifestVersion) {
      throw new ProviderProtocolResolutionError('provider-manifest-version-mismatch', 'Explicit binding manifest version does not match.');
    }
    const profile = manifest.protocolProfiles.find((candidate) => candidate.id === request.declaredProfileId
      && candidate.version === request.declaredProfileVersion);
    if (!profile) throw new ProviderProtocolResolutionError('protocol-profile-not-found', 'Explicit profile is not owned by this provider.');
    validateExplicitBuiltinEndpoint(manifest, profile, request);
    return authorize(manifest, request.providerId, request.modelId, request.operation, profile, request, request.declaredProfileVersion);
  }
  if (!model) {
    throw new ProviderProtocolResolutionError(
      'model-not-found',
      `Model '${request.modelId}' is not registered by provider '${request.providerId}'.`,
    );
  }

  const binding = model.protocolBindings.find((candidate) => candidate.operation === request.operation);
  if (!binding) {
    throw new ProviderProtocolResolutionError(
      'model-operation-not-bound',
      `Model '${model.id}' has no protocol binding for operation '${request.operation}'.`,
    );
  }
  if (request.declaredProfileId && request.declaredProfileId !== binding.protocolProfileId) {
    throw new ProviderProtocolResolutionError(
      'protocol-profile-model-mismatch',
      `Model '${model.id}' binds '${request.operation}' to '${binding.protocolProfileId}', not '${request.declaredProfileId}'.`,
    );
  }
  if (
    request.declaredProfileVersion !== undefined
    && request.declaredProfileVersion !== binding.protocolProfileVersion
  ) {
    throw new ProviderProtocolResolutionError(
      'protocol-profile-version-mismatch',
      `Model '${model.id}' binds '${request.operation}' to version ${binding.protocolProfileVersion}, not ${request.declaredProfileVersion}.`,
    );
  }

  const profile = manifest.protocolProfiles.find((candidate) => (
    candidate.id === binding.protocolProfileId
    && candidate.version === binding.protocolProfileVersion
  ));
  if (!profile) {
    throw new ProviderProtocolResolutionError(
      'provider-manifest-invalid',
      `Model '${model.id}' references missing protocol profile '${binding.protocolProfileId}' version ${binding.protocolProfileVersion}.`,
    );
  }
  return authorize(
    manifest,
    request.providerId,
    model.id,
    request.operation,
    profile,
    request,
    binding.protocolProfileVersion,
  );
}
