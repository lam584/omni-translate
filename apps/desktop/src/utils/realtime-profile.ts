import type {
  AppConfigDraft,
  ProviderDraft,
  ProviderModelCapabilityRegistryEntry,
  RealtimeAudioMode,
  RealtimeProtocol,
} from '../schema/config';

export type RealtimeProfileSource = 'registry' | 'template' | 'provider' | 'model-name' | 'none';
export type RealtimeRouteKind = 'omni' | 'openai-realtime' | 'gemini-live' | 'dashscope-asr' | 'local-vad';

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

function normalized(value: string) {
  return value.trim().toLowerCase();
}

function registryMatches(provider: ProviderDraft, modelId: string) {
  const key = normalized(modelId);
  return provider.localModelCapabilityRegistry.filter((entry) => normalized(entry.modelId) === key);
}

function findProvider(config: Pick<AppConfigDraft, 'providers'>, modelReference: string): ProviderMatch | null {
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
  return null;
}

function isDashScope(provider: ProviderDraft | null) {
  if (!provider) return false;
  return provider.kind === 'dashscope' || provider.templateId.toLowerCase().includes('dashscope');
}

function protocolFromExactRegistry(
  _provider: ProviderDraft,
  entry: ProviderModelCapabilityRegistryEntry,
): RealtimeProtocol | null {
  return entry.realtimeProtocol ?? null;
}

function inferProtocol(provider: ProviderDraft | null, modelId: string): RealtimeProtocol | null {
  const value = normalized(modelId);
  if (value.includes('gemini') && (value.includes('live') || value.includes('realtime') || value.includes('native-audio'))) return 'gemini-live';
  if (isDashScope(provider) && value.includes('livetranslate')) return 'dashscope-livetranslate';
  if (isDashScope(provider) && value.includes('omni') && value.includes('realtime')) return 'dashscope-omni';
  if (value.includes('qwen-audio') && value.includes('realtime')) return 'dashscope-omni';
  if (isDashScope(provider) && value.includes('asr') && value.includes('realtime')) return 'dashscope-asr';
  if (isDashScope(provider)) return 'dashscope-omni';
  if (provider?.kind === 'openai-compatible') {
    if (value.includes('translate')) return 'openai-translation';
    if (value.includes('transcribe') || value.includes('whisper')) return 'openai-transcription';
    if (value.includes('realtime') || value.includes('live')) return 'openai-conversation';
  }
  return null;
}

function defaultAudioMode(protocol: RealtimeProtocol | null, modelId: string, allowNameInference: boolean): RealtimeAudioMode {
  if (protocol === 'gemini-live') return 'gemini_auto_activity';
  if (protocol === 'dashscope-omni') return 'manual';
  if (allowNameInference && protocol === 'openai-transcription' && normalized(modelId).includes('whisper')) return 'manual';
  return 'server_vad';
}

export function resolveRealtimeProfile(
  config: Pick<AppConfigDraft, 'providers'>,
  modelReference: string,
): ResolvedRealtimeProfile {
  const match = findProvider(config, modelReference);
  const provider = match?.provider ?? null;
  const modelId = match?.modelId ?? (modelReference.split('::').pop() ?? modelReference);
  const matches = provider ? registryMatches(provider, modelId) : [];
  const registryEntry = matches[0];
  const diagnostics = matches.length > 1
    ? [`duplicate realtime registry entries for '${modelId}'; first entry '${matches[0].id}' is effective`]
    : [];

  const [protocolDialect, source]: [RealtimeProtocol | null, RealtimeProfileSource] = provider && registryEntry
    ? [protocolFromExactRegistry(provider, registryEntry), 'registry']
    : provider?.templateRealtimeProtocol
      ? [provider.templateRealtimeProtocol, 'template']
      : provider?.realtimeProtocol
        ? [provider.realtimeProtocol, 'provider']
        : (() => {
            const inferred = inferProtocol(provider, modelId);
            return [inferred, inferred ? 'model-name' : 'none'];
          })();

  const realtimeAudioMode = registryEntry?.realtimeAudioMode
    ?? defaultAudioMode(protocolDialect, modelId, source === 'model-name');
  const routeKind: RealtimeRouteKind = protocolDialect === 'dashscope-omni' || protocolDialect === 'dashscope-livetranslate'
    ? 'omni'
    : protocolDialect === 'gemini-live'
      ? 'gemini-live'
      : protocolDialect?.startsWith('openai-')
        ? 'openai-realtime'
        : protocolDialect === 'dashscope-asr'
          ? 'dashscope-asr'
          : 'local-vad';
  const serverSegmentation = routeKind !== 'local-vad';
  const nativeTranslation = protocolDialect === 'dashscope-omni'
    || protocolDialect === 'dashscope-livetranslate'
    || protocolDialect === 'openai-translation';
  const nativeAudioOutput = registryEntry
    ? registryEntry.capabilities.includes('speech-to-speech') || registryEntry.capabilities.includes('text-to-speech')
    : protocolDialect === 'dashscope-omni' || protocolDialect === 'openai-conversation' || protocolDialect === 'gemini-live';
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
    inputFormat: protocolDialect === 'dashscope-livetranslate' || protocolDialect === 'dashscope-asr' ? 'pcm' : 'pcm16',
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
