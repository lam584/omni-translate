import type {
  AppConfigDraft,
  ProviderDraft,
  ProviderModelCapabilityRegistryEntry,
  RealtimeAudioMode,
  RealtimeProtocol,
} from '../schema/config';
import {
  authorizeModelProtocolInvocation,
  lookupModelProtocolProfiles,
  type AuthorizedModelProtocolProfile,
  type ModelProtocolAuthorizationErrorCode,
  type ModelProtocolOperation,
  type ModelProtocolRegion,
  type ModelProtocolTransport,
} from '../model-protocol/profile-registry';

export type RealtimeProfileSource = 'manifest' | 'registry' | 'template' | 'provider' | 'model-name' | 'none';
export type RealtimeRouteKind = 'omni' | 'openai-realtime' | 'gemini-live' | 'dashscope-asr' | 'local-vad';

export type RealtimeProfileResolutionOptions = {
  operation?: ModelProtocolOperation;
};

export class RealtimeProfileAuthorizationError extends Error {
  constructor(
    public readonly code: ModelProtocolAuthorizationErrorCode,
    public readonly modelId: string,
  ) {
    super(code);
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

function normalized(value: string) {
  return value.trim().toLowerCase();
}

function registryMatches(provider: ProviderDraft, modelId: string) {
  const key = normalized(modelId);
  return provider.localModelCapabilityRegistry.filter((entry) => normalized(entry.modelId) === key);
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
  // or scene assignment. Provider order remains stable and deterministic.
  for (const provider of config.providers) {
    if (registryMatches(provider, modelReference).length > 0) return { provider, modelId: modelReference };
  }
  for (const provider of config.providers) {
    if (provider.model === modelReference || provider.sceneModelAssignments.some((assignment) => assignment.modelIds.includes(modelReference))) {
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
): never {
  throw new RealtimeProfileAuthorizationError(code, modelId);
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
  if (!result.ok) return rejectModelProtocol(result.errorCode, modelId);
  return result.authorization;
}

function protocolFromDashScopeAuthorization(
  authorization: AuthorizedModelProtocolProfile,
): RealtimeProtocol {
  switch (authorization.wireDialect) {
    case 'bailian-livetranslate-session-ws-v1':
      return 'dashscope-livetranslate';
    default:
      // Do not project newly enabled task, TTS, or dialogue products into the
      // legacy realtime union. Each needs an explicit executable pipeline
      // identity before it can become a route authority.
      return rejectModelProtocol('model_protocol.dialect_not_registered', authorization.exactModelId);
  }
}

function inferProtocol(provider: ProviderDraft | null, modelId: string): RealtimeProtocol | null {
  const value = normalized(modelId);
  const explicitGeminiProvider = provider?.templateId.toLowerCase().includes('gemini') === true;
  if (explicitGeminiProvider && value.includes('gemini') && (value.includes('live') || value.includes('realtime') || value.includes('native-audio'))) return 'gemini-live';
  if (provider?.kind === 'openai-compatible') {
    if (value.includes('translate')) return 'openai-translation';
    if (value.includes('transcribe') || value.includes('whisper')) return 'openai-transcription';
    if (value.includes('realtime') || value.includes('live')) return 'openai-conversation';
  }
  return null;
}

function defaultAudioMode(protocol: RealtimeProtocol | null, modelId: string, allowNameInference: boolean): RealtimeAudioMode {
  if (protocol === 'gemini-live') return 'gemini_auto_activity';
  if (allowNameInference && protocol === 'openai-transcription' && normalized(modelId).includes('whisper')) return 'manual';
  return 'server_vad';
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
  let protocolDialect: RealtimeProtocol | null;
  let source: RealtimeProfileSource;
  if (provider && isDashScope(provider)) {
    dashscopeAuthorization = authorizeDashScopeProfile(
      provider,
      registryEntry,
      modelId,
      options.operation ?? 'native_translate',
    );
    protocolDialect = protocolFromDashScopeAuthorization(dashscopeAuthorization);
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
    protocolDialect = inferProtocol(provider, modelId);
    source = protocolDialect ? 'model-name' : 'none';
  }
  if (!isDashScope(provider) && protocolDialect?.startsWith('dashscope-')) {
    return rejectModelProtocol('model_protocol.authorization_identity_mismatch', modelId);
  }

  const realtimeAudioMode = registryEntry?.realtimeAudioMode
    ?? defaultAudioMode(protocolDialect, modelId, source === 'model-name');
  const routeKind: RealtimeRouteKind = protocolDialect === 'dashscope-omni' || protocolDialect === 'dashscope-livetranslate'
    ? 'omni'
    : protocolDialect === 'gemini-live'
      ? 'gemini-live'
      : protocolDialect?.startsWith('openai-')
        ? 'openai-realtime'
        : 'local-vad';
  const serverSegmentation = routeKind !== 'local-vad';
  const nativeTranslation = protocolDialect === 'dashscope-livetranslate'
    || protocolDialect === 'openai-translation';
  const nativeAudioOutput = dashscopeAuthorization
    // `required` means the dialect always produces audio, not whether audio
    // output is supported. A non-empty authoritative codec set is the support
    // signal consumed by the legacy resolved-profile shape.
    ? dashscopeAuthorization.audioOutput.codecs.length > 0
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
    inputFormat: protocolDialect === 'dashscope-livetranslate' ? 'pcm' : 'pcm16',
    outputFormat: nativeAudioOutput ? (dashscopeRealtime ? 'pcm' : 'pcm16') : null,
    sampleRate: inputSampleRate,
    serverSegmentation,
    nativeTranslation,
    nativeAudioOutput,
    secondaryTranslationPolicy: nativeTranslation ? 'native' : 'secondary',
    speechDispatchPolicy: nativeAudioOutput ? 'native-audio' : nativeTranslation ? 'disabled' : 'subtitle-tts',
    preconnectPolicy: routeKind === 'omni' ? 'allowed' : 'disabled',
    timeoutBudgetMs: routeKind === 'omni' ? 95_000 : 30_000,
    source,
    diagnostics,
  };
}
