import type { AppIconName } from '../../components/icons/AppIcon';
import type {
  AudioRouteMode,
  ProviderCustomHeaderDraft,
  ProviderDraft,
  ProviderModelCapabilityRegistryEntry,
  ProviderModelCatalogCache,
  ProviderModelCatalogCacheItem,
  ProviderResponseModality,
  ProviderSceneModelAssignment,
  ProviderScenario,
  RealtimeAudioMode,
} from '../../schema/config';
import type { ProviderCapability, ProviderInteractionCapability, ProviderKind, ProviderTransport } from '../../schema/provider-contract';
import type { ProviderModelRuntime } from '../../schema/provider-runtime';
import type { ModelPreset, ProviderTemplate } from '../../schema/provider-template';
import i18n from '../../i18n/config';
import { useAppStore } from '../../stores/app-store';
import type { CustomProviderTemplateDraft } from '../../utils/custom-provider-templates';
import {
  normalizeProviderModels,
  resolveProviderModelCapabilities,
} from '../../utils/provider-model-capabilities';
import type { ProviderTemplateCatalogEntry } from '../../utils/provider-template-catalog';
import { parseRuntimeTimestampMs } from '../../utils/runtime-timestamp';
import { customProviderProfileKeyFromBinding } from '../../provider-manifest/custom-profile-options';

export type ModelCatalogState = {
  signature: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  source: 'runtime' | 'preset';
  models: ProviderModelRuntime[];
  error: string | null;
  fetchedAt: string | null;
  endpoint: string | null;
};

export type ModelCatalogScenarioFilter = 'all' | ProviderScenario;

export type PendingModelRegistration = {
  scenario: ProviderScenario;
  model: ProviderModelRuntime;
  capabilities: ProviderCapability[];
  realtimeAudioMode: RealtimeAudioMode;
  interactionCapabilities: ProviderInteractionCapability[];
};

const providerScenarioOrder: ProviderScenario[] = ['watch', 'game', 'voice-room', 'subtitle-translate'];

function formatProviderLabel(displayName: string) {
  return displayName.replace(/\s*API\s*/gi, ' ').replace(/\s{2,}/g, ' ').trim();
}

function formatTransportLabel(transport: ProviderTransport | string) {
  if (transport === 'streaming-http') {
    return i18n.t('providers.labels.streamingHttp');
  }

  if (transport === 'websocket') {
    return i18n.t('providers.labels.websocket');
  }

  return i18n.t('providers.labels.http');
}

function formatScenarioLabel(scenario: AudioRouteMode | ProviderScenario) {
  if (scenario === 'watch') {
    return i18n.t('providers.labels.scenario.watch');
  }

  if (scenario === 'game') {
    return i18n.t('providers.labels.scenario.game');
  }

  if (scenario === 'voice-room') {
    return i18n.t('providers.labels.scenario.voiceRoom');
  }

  if (scenario === 'subtitle-translate') {
    return i18n.t('providers.labels.scenario.subtitleTranslate');
  }

  return scenario;
}

function formatTimestampLabel(value: string | null) {
  if (!value) {
    return null;
  }

  const timestampMs = parseRuntimeTimestampMs(value);

  if (timestampMs === null) {
    return value;
  }

  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestampMs));
}

function formatSmokeStatusLabel(status: string) {
  return status === 'completed' ? i18n.t('providers.labels.smokeCompleted') : i18n.t('providers.labels.smokeFailed');
}

function formatSubtitlePriorityLabel(priority: string) {
  return priority === 'subtitle-first' ? i18n.t('providers.labels.subtitleFirst') : i18n.t('providers.labels.balanced');
}

function formatRuntimeErrorMessage(message: string, error?: unknown) {
  if (error instanceof Error && error.message) {
    return i18n.t('providers.labels.errorWithDetail', { message, detail: error.message });
  }

  if (typeof error === 'string' && error) {
    return i18n.t('providers.labels.errorWithDetail', { message, detail: error });
  }

  return message;
}

function resolveCapabilityIconName(capability: ProviderCapability): AppIconName {
  if (capability === 'speech-to-speech') {
    return 'wave';
  }

  if (capability === 'text-to-speech') {
    return 'headphones';
  }

  if (capability === 'text-generation') {
    return 'spark';
  }

  return 'mic';
}

function resolveTemplateIconName(kind: string): AppIconName {
  if (kind === 'dashscope') {
    return 'layers';
  }

  return 'spark';
}

function resolveModelIconName(model: ProviderModelRuntime): AppIconName {
  if (model.capabilities.includes('speech-to-speech')) {
    return 'wave';
  }

  if (model.capabilities.includes('text-to-speech')) {
    return 'headphones';
  }

  if (model.capabilities.includes('speech-to-text')) {
    return 'mic';
  }

  if (model.capabilities.includes('text-generation')) {
    return 'spark';
  }

  return 'spark';
}

function formatModelCatalogSourceLabel(source: ModelCatalogState['source']) {
  return source === 'runtime' ? i18n.t('providers.labels.runtimeCatalog') : i18n.t('providers.labels.presetFallback');
}

function defaultBaseUrlForKind(kind: ProviderKind) {
  if (kind === 'dashscope') {
    return 'https://dashscope.aliyuncs.com/api/v1';
  }
  if (kind === 'openrouter') {
    return 'https://openrouter.ai/api/v1';
  }
  if (kind === 'ollama') {
    return 'http://localhost:11434/v1';
  }
  if (kind === 'lmstudio') {
    return 'http://localhost:1234/v1';
  }
  if (kind === 'nvidia') {
    return 'https://integrate.api.nvidia.com/v1';
  }

  return 'https://api.openai.com/v1';
}

function defaultCompatibleDashscopeBaseUrl() {
  return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
}

function supportedTransportsForKind(kind: ProviderKind): ProviderTransport[] {
  if (kind === 'dashscope') return ['http', 'websocket'];
  if (kind === 'openrouter' || kind === 'ollama' || kind === 'lmstudio' || kind === 'nvidia') return ['http', 'streaming-http'];
  return ['http', 'streaming-http'];
}

function defaultTransportForKind(kind: ProviderKind): ProviderTransport {
  return kind === 'dashscope' ? 'websocket' : 'streaming-http';
}

function defaultPromptTemplateForKind(kind: ProviderKind) {
  return kind === 'dashscope' ? 'game-live-translation-cn' : 'video-realtime-cn';
}

function createDefaultCustomProviderDraft(kind: ProviderKind = 'openai-compatible'): CustomProviderTemplateDraft {
  return {
    displayName: '',
    kind,
    baseUrl: defaultBaseUrlForKind(kind),
    model: '',
    transport: defaultTransportForKind(kind),
    authReference: '',
    authHeaderName: 'Authorization',
    authScheme: 'bearer',
    region: kind === 'dashscope' ? 'cn-beijing' : '',
    streamEnabled: true,
    timeoutMs: 15000,
    systemPromptTemplate: defaultPromptTemplateForKind(kind),
    protocolProfileKey: '',
  };
}

function providerDraftToCustomProviderTemplateDraft(provider: ProviderDraft): CustomProviderTemplateDraft {
  return {
    displayName: provider.displayName,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    model: provider.model,
    transport: provider.transport,
    authReference: provider.authRef.reference,
    authHeaderName: provider.authRef.headerName,
    authScheme: provider.authRef.scheme,
    region: provider.region ?? '',
    streamEnabled: provider.streamEnabled,
    timeoutMs: provider.timeoutMs,
    systemPromptTemplate: provider.systemPromptTemplate,
    protocolProfileKey: customProviderProfileKeyFromBinding(provider.modelProtocolBindings?.[0]),
  };
}

function resolveDashscopeOrigin(baseUrl: string) {
  try {
    const normalized = baseUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
    const parsed = new URL(normalized);

    if (/^dashscope(-intl)?\.aliyuncs\.com$/i.test(parsed.hostname)) {
      return parsed.origin;
    }
  } catch {
    return null;
  }

  return null;
}

function resolveBaseUrlForApiFormat(kind: ProviderKind, currentBaseUrl: string, template: ProviderTemplate) {
  const dashscopeOrigin = resolveDashscopeOrigin(currentBaseUrl) ?? resolveDashscopeOrigin(template.defaultDraft.baseUrl);

  if (kind === 'dashscope') {
    if (dashscopeOrigin) {
      return `${dashscopeOrigin}/api/v1`;
    }

    return defaultBaseUrlForKind('dashscope');
  }

  if (dashscopeOrigin) {
    return `${dashscopeOrigin}/compatible-mode/v1`;
  }

  return template.defaultDraft.kind === 'openai-compatible' ? template.defaultDraft.baseUrl : defaultCompatibleDashscopeBaseUrl();
}

function normalizeBaseUrlForComparison(value: string) {
  return value.trim().replace(/\/+$/, '');
}

function shouldUseTemplatePresetModels(template: ProviderTemplate, currentBaseUrl: string) {
  return normalizeBaseUrlForComparison(template.defaultDraft.baseUrl) === normalizeBaseUrlForComparison(currentBaseUrl);
}

function buildModelCatalogSignature(provider: ProviderDraft) {
  return [provider.templateId, provider.providerId, provider.kind, provider.baseUrl, provider.authRef.reference].join('|');
}

function presetToRuntimeModel(presetModel: ModelPreset): ProviderModelRuntime {
  return {
    id: presetModel.model,
    displayName: presetModel.displayName,
    ownedBy: 'preset',
    createdAt: null,
    capabilities: presetModel.capabilities,
  };
}

function createDerivedRuntimeModel(modelId: string, registry: ProviderModelCapabilityRegistryEntry[], ownedBy: string | null = null): ProviderModelRuntime {
  const baseModel: ProviderModelRuntime = {
    id: modelId.trim(),
    displayName: modelId.trim(),
    ownedBy,
    createdAt: null,
    capabilities: [],
  };

  return {
    ...baseModel,
    capabilities: resolveProviderModelCapabilities(baseModel, registry),
  };
}

function buildFallbackModels(
  template: ProviderTemplate,
  currentModel: string,
  registry: ProviderModelCapabilityRegistryEntry[],
  currentBaseUrl: string,
): ProviderModelRuntime[] {
  const allowTemplatePresets = shouldUseTemplatePresetModels(template, currentBaseUrl);
  const presetModels = allowTemplatePresets ? normalizeProviderModels(template.presetModels.map(presetToRuntimeModel), registry) : [];
  const normalizedCurrentModel = currentModel.trim();

  if (
    normalizedCurrentModel &&
    !presetModels.some((model) => model.id === normalizedCurrentModel) &&
    (allowTemplatePresets || normalizedCurrentModel !== template.defaultDraft.model.trim())
  ) {
    presetModels.unshift(createDerivedRuntimeModel(normalizedCurrentModel, registry, 'current'));
  }

  return presetModels;
}

function dedupeModels(models: ProviderModelRuntime[]) {
  const seen = new Set<string>();

  return models.filter((model) => {
    if (seen.has(model.id)) {
      return false;
    }

    seen.add(model.id);
    return true;
  });
}

function cacheItemToRuntimeModel(item: ProviderModelCatalogCacheItem): ProviderModelRuntime {
  return {
    id: item.id,
    displayName: item.displayName,
    ownedBy: item.ownedBy,
    createdAt: item.createdAt,
    capabilities: item.capabilities,
  };
}

function runtimeModelToCacheItem(model: ProviderModelRuntime, providerTemplateId?: string, providerTemplateName?: string): ProviderModelCatalogCacheItem {
  return {
    id: model.id,
    displayName: model.displayName,
    ownedBy: model.ownedBy ?? null,
    createdAt: model.createdAt ?? null,
    capabilities: model.capabilities,
    providerTemplateId: providerTemplateId ?? '',
    providerTemplateName: providerTemplateName ?? '',
  };
}

function createEmptyModelCatalogCache(): ProviderModelCatalogCache {
  return {
    signature: '',
    source: 'preset',
    endpoint: null,
    fetchedAt: null,
    error: null,
    models: [],
  };
}

function createFallbackModelCatalog(
  signature: string,
  template: ProviderTemplate,
  currentModel: string,
  registry: ProviderModelCapabilityRegistryEntry[],
  currentBaseUrl: string,
): ModelCatalogState {
  return {
    signature,
    status: 'idle',
    source: 'preset',
    models: buildFallbackModels(template, currentModel, registry, currentBaseUrl),
    error: null,
    fetchedAt: null,
    endpoint: null,
  };
}

function createEmptyModelCatalog(signature: string, status: ModelCatalogState['status'] = 'idle', error: string | null = null): ModelCatalogState {
  return {
    signature,
    status,
    source: 'runtime',
    models: [],
    error,
    fetchedAt: null,
    endpoint: null,
  };
}

function hasCachedModelCatalog(cache: ProviderModelCatalogCache, signature: string) {
  return cache.signature === signature && (cache.models.length > 0 || cache.error !== null || cache.fetchedAt !== null);
}

function buildModelCatalogStateFromCache(
  signature: string,
  cache: ProviderModelCatalogCache,
  template: ProviderTemplate,
  currentModel: string,
  registry: ProviderModelCapabilityRegistryEntry[],
  currentBaseUrl: string,
): ModelCatalogState {
  const cachedModels = normalizeProviderModels(cache.models.map(cacheItemToRuntimeModel), registry);
  const fallbackModels = buildFallbackModels(template, currentModel, registry, currentBaseUrl);

  return {
    signature,
    status: cache.error ? 'error' : 'ready',
    source: cache.source,
    models: dedupeModels([...cachedModels, ...fallbackModels]),
    error: cache.error,
    fetchedAt: cache.fetchedAt,
    endpoint: cache.endpoint,
  };
}

function buildModelCatalogCache(
  signature: string,
  source: 'runtime' | 'preset',
  models: ProviderModelRuntime[],
  endpoint: string | null,
  fetchedAt: string | null,
  error: string | null,
  providerTemplateId: string,
  providerTemplateName: string,
): ProviderModelCatalogCache {
  const normalizedModels = models.map((m) => runtimeModelToCacheItem(m, providerTemplateId, providerTemplateName));

  return {
    signature,
    source,
    endpoint,
    fetchedAt,
    error,
    models: normalizedModels,
  };
}

const globalTemplateSceneAssignments = new Map<string, ProviderSceneModelAssignment[]>();

function ensureSceneAssignments(assignments: ProviderSceneModelAssignment[] | undefined | null) {
  return providerScenarioOrder.map((scenario) => ({
    scenario,
    modelIds: assignments?.find((item) => item.scenario === scenario)?.modelIds ?? [],
  }));
}

function createCustomHeaderDraft(): ProviderCustomHeaderDraft {
  return {
    id: `header-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    value: '',
    enabled: true,
  };
}

function reorderTemplateEntries(entries: ProviderTemplateCatalogEntry[], sourceTemplateId: string, targetTemplateId: string) {
  if (!sourceTemplateId || sourceTemplateId === targetTemplateId) {
    return entries;
  }

  const nextEntries = [...entries];
  const draggingIndex = nextEntries.findIndex((entry) => entry.template.id === sourceTemplateId);
  const targetIndex = nextEntries.findIndex((entry) => entry.template.id === targetTemplateId);

  if (draggingIndex < 0 || targetIndex < 0) {
    return entries;
  }

  const [draggingEntry] = nextEntries.splice(draggingIndex, 1);
  nextEntries.splice(targetIndex, 0, draggingEntry);
  return nextEntries;
}

function addSceneModel(assignments: ProviderSceneModelAssignment[], scenario: ProviderScenario, modelId: string) {
  return assignments.map((item) =>
    item.scenario === scenario
      ? { ...item, modelIds: item.modelIds.includes(modelId) ? item.modelIds : [...item.modelIds, modelId] }
      : item,
  );
}

function addSceneModelToAll(assignments: ProviderSceneModelAssignment[], modelId: string) {
  return assignments.map((item) => ({
    ...item,
    modelIds: item.modelIds.includes(modelId) ? item.modelIds : [...item.modelIds, modelId],
  }));
}

function removeSceneModel(
  assignments: ProviderSceneModelAssignment[],
  scenario: ProviderScenario,
  modelId: string,
  currentScenario: AudioRouteMode,
  activeModel: string,
  defaultModel: string,
) {
  const nextAssignments = assignments.map((item) =>
    item.scenario === scenario ? { ...item, modelIds: item.modelIds.filter((id) => id !== modelId) } : item,
  );
  const nextCurrentScenarioModels = nextAssignments.find((item) => item.scenario === currentScenario)?.modelIds ?? [];

  return {
    assignments: nextAssignments,
    nextModel: scenario === currentScenario && activeModel === modelId ? nextCurrentScenarioModels[0] ?? defaultModel : undefined,
  };
}

function removeSceneModelFromAll(
  assignments: ProviderSceneModelAssignment[],
  modelId: string,
  currentScenario: AudioRouteMode,
  activeModel: string,
  defaultModel: string,
) {
  const nextAssignments = assignments.map((item) => ({ ...item, modelIds: item.modelIds.filter((id) => id !== modelId) }));
  const nextCurrentScenarioModels = nextAssignments.find((item) => item.scenario === currentScenario)?.modelIds ?? [];

  return {
    assignments: nextAssignments,
    nextModel: activeModel === modelId ? nextCurrentScenarioModels[0] ?? defaultModel : undefined,
  };
}

function toggleResponseModalities(modalities: ProviderResponseModality[], modality: ProviderResponseModality): ProviderResponseModality[] {
  const nextModalities = modalities.includes(modality) ? modalities.filter((item) => item !== modality) : [...modalities, modality];
  return nextModalities.length > 0 ? nextModalities : ['text'];
}

function reorderSceneModels(
  assignments: ProviderSceneModelAssignment[],
  draggingSceneModel: { scenario: ProviderScenario; modelId: string } | null,
  scenario: ProviderScenario,
  targetModelId: string,
) {
  if (!draggingSceneModel || draggingSceneModel.scenario !== scenario || draggingSceneModel.modelId === targetModelId) {
    return assignments;
  }

  return assignments.map((item) => {
    if (item.scenario !== scenario) {
      return item;
    }

    const nextModelIds = [...item.modelIds];
    const draggingIndex = nextModelIds.indexOf(draggingSceneModel.modelId);
    const targetIndex = nextModelIds.indexOf(targetModelId);

    if (draggingIndex < 0 || targetIndex < 0) {
      return item;
    }

    const [draggingModelId] = nextModelIds.splice(draggingIndex, 1);
    nextModelIds.splice(targetIndex, 0, draggingModelId);
    return { ...item, modelIds: nextModelIds };
  });
}

function getActiveProviderFromState(): ProviderDraft | undefined {
  const state = useAppStore.getState();
  return state.configDraft.providers.find((p) => p.templateId === state.configDraft.activeProviderTemplateId)
    ?? state.configDraft.providers[0];
}

export const providersPageHelpers = {
  providerScenarioOrder,
  globalTemplateSceneAssignments,
  formatProviderLabel,
  formatTransportLabel,
  formatScenarioLabel,
  formatTimestampLabel,
  formatSmokeStatusLabel,
  formatSubtitlePriorityLabel,
  formatRuntimeErrorMessage,
  resolveCapabilityIconName,
  resolveTemplateIconName,
  resolveModelIconName,
  formatModelCatalogSourceLabel,
  defaultBaseUrlForKind,
  defaultCompatibleDashscopeBaseUrl,
  supportedTransportsForKind,
  defaultTransportForKind,
  defaultPromptTemplateForKind,
  createDefaultCustomProviderDraft,
  providerDraftToCustomProviderTemplateDraft,
  resolveDashscopeOrigin,
  resolveBaseUrlForApiFormat,
  normalizeBaseUrlForComparison,
  shouldUseTemplatePresetModels,
  buildModelCatalogSignature,
  presetToRuntimeModel,
  createDerivedRuntimeModel,
  buildFallbackModels,
  dedupeModels,
  cacheItemToRuntimeModel,
  runtimeModelToCacheItem,
  createEmptyModelCatalogCache,
  createFallbackModelCatalog,
  createEmptyModelCatalog,
  hasCachedModelCatalog,
  buildModelCatalogStateFromCache,
  buildModelCatalogCache,
  ensureSceneAssignments,
  createCustomHeaderDraft,
  reorderTemplateEntries,
  addSceneModel,
  addSceneModelToAll,
  removeSceneModel,
  removeSceneModelFromAll,
  toggleResponseModalities,
  reorderSceneModels,
  getActiveProviderFromState,
};
