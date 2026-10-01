import { effectiveProviderModelRegistry } from './provider-model-capabilities-registry';
import { resolveProviderProtocol } from '../provider-manifest/resolver';
import type { ProviderManifestOperation } from '../provider-manifest/types';
import type {
  AppConfigDraft,
  ProviderDraft,
  ProviderModelCapabilityRegistryEntry,
  RealtimeAudioMode,
  RealtimeProtocol,
} from '../schema/config';
import {
  authorizeModelProtocolInvocation,
  MODEL_PROTOCOL_REGISTRY,
  lookupModelProtocolProfiles,
  type AuthorizedModelProtocolProfile,
  type ModelProtocolAuthorizationErrorCode,
  type ModelProtocolOperation,
  type ModelProtocolRegion,
  type ModelProtocolTransport,
} from '../model-protocol/profile-registry';
import { PROVIDER_MANIFEST_REGISTRY } from '../provider-manifest/bundle';
import type { ProviderManifestProtocolProfile } from '../provider-manifest/types';

export type RealtimeProfileSource = 'manifest' | 'registry' | 'template' | 'provider' | 'none';
export type RealtimeRouteKind = 'omni' | 'openai-realtime' | 'gemini-live' | 'dashscope-asr' | 'local-vad';

export type RealtimeProfileResolutionOptions = {
  operation?: ModelProtocolOperation;
};

export class RealtimeProfileAuthorizationError extends Error {
  constructor(
    public readonly code: ModelProtocolAuthorizationErrorCode,
    public readonly modelId: string,
    message?: string,
  ) {
    super(message ? `${code}: ${message}` : code);
    this.name = 'RealtimeProfileAuthorizationError';
  }
}

export type ResolvedRealtimeProfile = {
  providerId: string | null;
  modelId: string;
  routeKind: RealtimeRouteKind;
  protocolDialect: RealtimeProtocol | null;
  realtimeAudioMode: RealtimeAudioMode;
  inputFormat: 'pcm' | 'pcm16';
  outputFormat: 'pcm' | 'pcm16' | null;
  sampleRate: number;
  serverSegmentation: boolean;
  nativeTranslation: boolean;
  invocationOperation?: ModelProtocolOperation;
  translationExecution?: 'dedicated-realtime' | 'prompted-realtime' | 'text-worker';
  nativeAudioOutput: boolean;
  secondaryTranslationPolicy: 'native' | 'secondary';
  speechDispatchPolicy: 'native-audio' | 'subtitle-tts' | 'disabled';
  preconnectPolicy: 'allowed' | 'disabled';
  timeoutBudgetMs: number;
  source: RealtimeProfileSource;
  diagnostics: string[];
};

type ProviderMatch = { provider: ProviderDraft; modelId: string };
type RealtimeProfileConfig = Pick<AppConfigDraft, 'providers'>
  & Partial<Pick<AppConfigDraft, 'activeProviderTemplateId'>>;

function registryMatches(provider: ProviderDraft, modelId: string) {
  const entries = provider.modelRegistryVersion === 2 ? effectiveProviderModelRegistry(provider) : provider.localModelCapabilityRegistry;
  return entries.filter((entry) => entry.modelId === modelId);
}

function findProvider(config: RealtimeProfileConfig, modelReference: string): ProviderMatch | null {
  const compositeSeparator = modelReference.indexOf('::');
  if (compositeSeparator >= 0) {
    const templateId = modelReference.slice(0, compositeSeparator);
    const modelId = modelReference.slice(compositeSeparator + 2);
    const provider = config.providers.find((candidate) => candidate.templateId === templateId);
    return provider ? { provider, modelId } : null;
  }

  // An exact registry declaration is stronger than a provider's current model
  // or candidate group. Provider order remains stable and deterministic.
  for (const provider of config.providers) {
    if (registryMatches(provider, modelReference).length > 0) return { provider, modelId: modelReference };
  }
  for (const provider of config.providers) {
    if (provider.model === modelReference || provider.candidateModelGroups?.some((assignment) => assignment.modelIds.includes(modelReference))) {
      return { provider, modelId: modelReference };
    }
  }

  // A bare, newly selected model may not yet be present in local UI metadata.
  // Keep that case inside DashScope's fail-closed manifest boundary instead of
  // silently treating it as a provider-less local-vad model. An explicitly
  // active non-DashScope provider retains the legacy provider-less behavior.
  if (config.activeProviderTemplateId) {
    const activeProvider = config.providers.find((candidate) => candidate.templateId === config.activeProviderTemplateId);
    return activeProvider && isDashScope(activeProvider)
      ? { provider: activeProvider, modelId: modelReference }
      : null;
  }
  const dashScopeProviders = config.providers.filter(isDashScope);
  if (dashScopeProviders.length === 1) {
    return { provider: dashScopeProviders[0], modelId: modelReference };
  }
  return null;
}

function isDashScope(provider: ProviderDraft | null) {
  if (!provider) return false;
  return provider.kind === 'dashscope';
}

function protocolFromExactRegistry(
  _provider: ProviderDraft,
  entry: ProviderModelCapabilityRegistryEntry,
): RealtimeProtocol | null {
  return entry.realtimeProtocol ?? null;
}

function rejectModelProtocol(
  code: ModelProtocolAuthorizationErrorCode,
  modelId: string,
  message?: string,
): never {
  throw new RealtimeProfileAuthorizationError(code, modelId, message);
}

function providerEndpointHost(provider: ProviderDraft): string {
  try {
    return new URL(provider.baseUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function authorizeDashScopeProfile(
  provider: ProviderDraft,
  entry: ProviderModelCapabilityRegistryEntry | undefined,
  modelId: string,
  operation: ModelProtocolOperation,
): AuthorizedModelProtocolProfile {
  const boundOperation: ProviderManifestOperation = operation === 'native_translate' ? 'realtime-translation' : operation === 'dialogue' ? 'realtime-conversation' : operation === 'asr' ? 'asr' : operation === 'tts' ? 'tts' : 'voice-clone';
  const explicit = provider.modelProtocolBindings?.find((binding) => binding.modelId === modelId && binding.operation === boundOperation);
  if (provider.modelRegistryVersion === 2 && explicit) {
    const authority = resolveProviderProtocol([...PROVIDER_MANIFEST_REGISTRY.all()], {
      providerId: provider.providerId, templateId: provider.templateId, modelId,
      operation: boundOperation, modelRegistryVersion: 2,
      declaredProfileId: explicit.profileId, declaredProfileVersion: explicit.profileVersion,
      declaredManifestVersion: explicit.manifestVersion,
      baseUrl: provider.baseUrl, transport: provider.transport, region: provider.region,
    });
    if (authority.profileOwnerProviderId !== explicit.profileOwnerProviderId) return rejectModelProtocol('model_protocol.authorization_identity_mismatch', modelId);
    if (lookupModelProtocolProfiles(modelId).length === 0) {
      const profile = MODEL_PROTOCOL_REGISTRY.profiles.find((candidate) => candidate.profileId === explicit.profileId && candidate.profileVersion === explicit.profileVersion);
      if (!profile) return rejectModelProtocol('model_protocol.profile_id_mismatch', modelId);
      const result = authorizeModelProtocolInvocation({ exactModelId: modelId, operation,
        transport: provider.transport as ModelProtocolTransport, region: provider.region as ModelProtocolRegion,
        endpointHost: providerEndpointHost(provider), declaredProfileId: explicit.profileId, declaredProfileVersion: explicit.profileVersion,
      }, { ...MODEL_PROTOCOL_REGISTRY, profiles: [{ ...profile, exactModelIds: [modelId] }] });
      if (!result.ok) return rejectModelProtocol(result.errorCode, modelId, result.message);
      return result.authorization;
    }
  }
  if (entry && (
    entry.registryVersion === undefined
    || entry.profileId === undefined
    || entry.profileVersion === undefined
  )) {
    return rejectModelProtocol('model_protocol.authorization_identity_mismatch', modelId);
  }

  const result = authorizeModelProtocolInvocation({
    exactModelId: modelId,
    operation,
    transport: provider.transport as ModelProtocolTransport,
    region: provider.region as ModelProtocolRegion,
    endpointHost: providerEndpointHost(provider),
    declaredRegistryVersion: entry?.registryVersion,
    declaredProfileId: entry?.profileId,
    declaredProfileVersion: entry?.profileVersion,
  });
  if (!result.ok) return rejectModelProtocol(result.errorCode, modelId, result.message);
  return result.authorization;
}

export function primaryDashScopeOperation(provider: ProviderDraft, modelId: string): ModelProtocolOperation {
  const profiles = lookupModelProtocolProfiles(modelId);
  if (profiles.length > 1) return rejectModelProtocol('model_protocol.profile_ambiguous', modelId);
  const dialect = profiles[0]?.dialectId;
  if (dialect === 'bailian-omni-realtime-ws-v2' || dialect === 'bailian-qwen-audio-chat-realtime-ws-v1') return 'dialogue';
  if (dialect === 'bailian-qwen-audio-asr-task-ws-v1') return 'asr';
  if (profiles.length > 0) return 'native_translate';
  const bindings = provider.modelProtocolBindings?.filter(binding => binding.modelId === modelId
    && ['realtime-translation', 'realtime-conversation', 'asr', 'realtime-transcription'].includes(binding.operation)) ?? [];
  if (bindings.length > 1) return rejectModelProtocol('model_protocol.profile_ambiguous', modelId);
  return bindings[0]?.operation === 'realtime-conversation' ? 'dialogue'
    : bindings[0]?.operation === 'asr' || bindings[0]?.operation === 'realtime-transcription' ? 'asr' : 'native_translate';
}

function protocolFromDashScopeAuthorization(
  authorization: AuthorizedModelProtocolProfile,
): RealtimeProtocol {
  const identity = [authorization.adapterId, authorization.wireDialect, authorization.wireDialectVersion].join(':');
  switch (identity) {
    case 'desktop-livetranslate-session-v1:bailian-livetranslate-session-ws-v1:1':
    case 'desktop-livetranslate-session-v2:bailian-livetranslate-session-ws-v2:2':
      return 'dashscope-livetranslate';
    case 'desktop-omni-session-v2:bailian-omni-realtime-ws-v2:2':
      return 'dashscope-omni';
    case 'desktop-qwen-audio-session-v1:bailian-qwen-audio-chat-realtime-ws-v1:1':
      return 'dashscope-qwen-audio';
    case 'desktop-qwen-audio-task-asr-v1:bailian-qwen-audio-asr-task-ws-v1:1':
      return 'dashscope-asr';
    default:
      return rejectModelProtocol('model_protocol.adapter_unavailable', authorization.exactModelId);
  }
}

function defaultAudioMode(protocol: RealtimeProtocol | null): RealtimeAudioMode {
  if (protocol === 'gemini-live') return 'gemini_auto_activity';
  return 'server_vad';
}

function manifestProtocol(profile: ProviderManifestProtocolProfile): RealtimeProtocol | null {
  if (profile.adapter.id === 'gemini-live' && profile.operations.includes('realtime-conversation')) {
    return 'gemini-live';
  }
  if (
    profile.adapter.id === 'openai-realtime-websocket'
    || profile.adapter.id === 'azure-openai-realtime-websocket'
  ) {
    if (profile.operations.includes('realtime-conversation')) return 'openai-conversation';
    if (profile.operations.includes('realtime-translation')) return 'openai-translation';
    if (profile.operations.includes('realtime-transcription')) return 'openai-transcription';
  }
  return null;
}

function exactManifestRealtimeProfile(
  provider: ProviderDraft,
  modelId: string,
): { matchedProvider: boolean; profile: ProviderManifestProtocolProfile | null } {
  const builtIn = PROVIDER_MANIFEST_REGISTRY.findByTemplateId(provider.templateId);
  if (builtIn) {
    const model = builtIn.models.find((candidate) => candidate.id === modelId);
    if (!model) return { matchedProvider: true, profile: null };
    const realtimeBindings = model.protocolBindings.filter((binding) => binding.operation.startsWith('realtime-'));
    if (realtimeBindings.length !== 1) return { matchedProvider: true, profile: null };
    const binding = realtimeBindings[0];
    return {
      matchedProvider: true,
      profile: builtIn.protocolProfiles.find((candidate) => (
        candidate.id === binding.protocolProfileId
        && candidate.version === binding.protocolProfileVersion
        && candidate.adapter.status === 'enabled'
      )) ?? null,
    };
  }
  if (provider.templateSource !== 'custom') return { matchedProvider: false, profile: null };
  const bindings = provider.modelProtocolBindings?.filter((binding) => (
    binding.modelId === modelId && binding.operation.startsWith('realtime-')
  )) ?? [];
  if (bindings.length !== 1) return { matchedProvider: true, profile: null };
  const binding = bindings[0];
  const owner = PROVIDER_MANIFEST_REGISTRY.findByProviderId(binding.profileOwnerProviderId);
  if (!owner || owner.manifestVersion !== binding.manifestVersion) {
    return { matchedProvider: true, profile: null };
  }
  return {
    matchedProvider: true,
    profile: owner.protocolProfiles.find((candidate) => (
      candidate.id === binding.profileId
      && candidate.version === binding.profileVersion
      && candidate.customProviderPolicy === 'explicit-profile'
      && candidate.adapter.status === 'enabled'
    )) ?? null,
  };
}

function manifestRealtimeAudioMode(profile: ProviderManifestProtocolProfile): RealtimeAudioMode {
  if (profile.adapter.id === 'gemini-live') return 'gemini_auto_activity';
  const lifecycle = PROVIDER_MANIFEST_REGISTRY.all().flatMap((manifest) => manifest.lifecycleProfiles)
    .find((candidate) => candidate.id === profile.lifecycleProfileId);
  if (lifecycle?.vadModes.includes('server-vad')) return 'server_vad';
  if (lifecycle?.vadModes.includes('semantic-vad')) return 'semantic_vad';
  return 'manual';
}

export function resolveRealtimeProfile(
  config: RealtimeProfileConfig,
  modelReference: string,
  options: RealtimeProfileResolutionOptions = {},
): ResolvedRealtimeProfile {
  const match = findProvider(config, modelReference);
  const provider = match?.provider ?? null;
  const modelId = match?.modelId ?? modelReference.split('::').slice(-1)[0];
  if (lookupModelProtocolProfiles(modelId).length > 0 && !isDashScope(provider)) {
    return rejectModelProtocol('model_protocol.authorization_identity_mismatch', modelId);
  }
  const matches = provider ? registryMatches(provider, modelId) : [];
  const registryEntry = matches[0];
  const diagnostics = matches.length > 1
    ? [`duplicate realtime registry entries for '${modelId}'; first entry '${matches[0].id}' is effective`]
    : [];

  let dashscopeAuthorization: AuthorizedModelProtocolProfile | null = null;
  const genericManifest = provider && !isDashScope(provider)
    ? exactManifestRealtimeProfile(provider, modelId)
    : { matchedProvider: false, profile: null };
  let protocolDialect: RealtimeProtocol | null;
  let source: RealtimeProfileSource;
  if (provider && isDashScope(provider)) {
    dashscopeAuthorization = authorizeDashScopeProfile(
      provider,
      // V2 capability overrides are advisory, not profile identity assertions.
      provider.modelRegistryVersion === 2 ? undefined : registryEntry,
      modelId,
      options.operation ?? primaryDashScopeOperation(provider, modelId),
    );
    protocolDialect = protocolFromDashScopeAuthorization(dashscopeAuthorization);
    source = 'manifest';
  } else if (genericManifest.matchedProvider) {
    protocolDialect = genericManifest.profile ? manifestProtocol(genericManifest.profile) : null;
    source = 'manifest';
  } else if (provider && registryEntry) {
    protocolDialect = protocolFromExactRegistry(provider, registryEntry);
    source = 'registry';
  } else if (provider?.templateRealtimeProtocol) {
    protocolDialect = provider.templateRealtimeProtocol;
    source = 'template';
  } else if (provider?.realtimeProtocol) {
    protocolDialect = provider.realtimeProtocol;
    source = 'provider';
  } else {
    protocolDialect = null;
    source = 'none';
  }
  if (!isDashScope(provider) && protocolDialect?.startsWith('dashscope-')) {
    return rejectModelProtocol('model_protocol.authorization_identity_mismatch', modelId);
  }

  const realtimeAudioMode = genericManifest.profile
    ? manifestRealtimeAudioMode(genericManifest.profile)
    : registryEntry?.realtimeAudioMode ?? defaultAudioMode(protocolDialect);
  const routeKind: RealtimeRouteKind = protocolDialect === 'dashscope-omni' || protocolDialect === 'dashscope-qwen-audio' || protocolDialect === 'dashscope-livetranslate'
    ? 'omni'
    : protocolDialect === 'dashscope-asr' ? 'dashscope-asr'
    : protocolDialect === 'gemini-live'
      ? 'gemini-live'
      : protocolDialect?.startsWith('openai-')
        ? 'openai-realtime'
        : 'local-vad';
  const serverSegmentation = routeKind !== 'local-vad';
  const translationExecution = protocolDialect === 'dashscope-omni' || protocolDialect === 'dashscope-qwen-audio'
    ? 'prompted-realtime' : protocolDialect === 'dashscope-livetranslate' || protocolDialect === 'openai-translation'
      ? 'dedicated-realtime' : 'text-worker';
  const nativeTranslation = translationExecution !== 'text-worker';
  const nativeAudioOutput = dashscopeAuthorization
    // `required` means the dialect always produces audio, not whether audio
    // output is supported. A non-empty authoritative codec set is the support
    // signal consumed by the legacy resolved-profile shape.
    ? dashscopeAuthorization.audioOutput.codecs.length > 0
    : genericManifest.profile
      ? genericManifest.profile.capabilities.includes('speech-to-speech')
        || genericManifest.profile.capabilities.includes('text-to-speech')
    : registryEntry
      ? registryEntry.capabilities.includes('speech-to-speech') || registryEntry.capabilities.includes('text-to-speech')
    : protocolDialect === 'openai-conversation' || protocolDialect === 'gemini-live';
  const dashscopeRealtime = protocolDialect?.startsWith('dashscope-') === true;
  const inputSampleRate = dashscopeRealtime || protocolDialect === 'openai-flat' || protocolDialect === 'gemini-live'
    ? 16_000
    : 24_000;

  return {
    providerId: provider?.providerId ?? null,
    modelId,
    routeKind,
    protocolDialect,
    realtimeAudioMode,
    inputFormat: protocolDialect?.startsWith('dashscope-') ? 'pcm' : 'pcm16',
    outputFormat: nativeAudioOutput ? (dashscopeRealtime ? 'pcm' : 'pcm16') : null,
    sampleRate: inputSampleRate,
    serverSegmentation,
    nativeTranslation,
    invocationOperation: dashscopeAuthorization?.operation ?? options.operation ?? 'native_translate',
    translationExecution,
    nativeAudioOutput,
    secondaryTranslationPolicy: nativeTranslation ? 'native' : 'secondary',
    speechDispatchPolicy: nativeAudioOutput ? 'native-audio' : nativeTranslation ? 'disabled' : 'subtitle-tts',
    preconnectPolicy: routeKind === 'omni' ? 'allowed' : 'disabled',
    timeoutBudgetMs: routeKind === 'omni' ? 95_000 : 30_000,
    source,
    diagnostics,
  };
}
