import { invoke } from '@tauri-apps/api/core';
import { type MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import AppIcon, { type AppIconName } from '../components/icons/AppIcon';
import DiagnosticsQuickLink from '../components/page/DiagnosticsQuickLink';
import PageSectionHeader from '../components/page/PageSectionHeader';
import StatusBadge, { type StatusTone } from '../components/page/StatusBadge';
import { defaultProviderTemplate, providerTemplates } from '../mocks/provider-templates';
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
} from '../schema/config';
import type { ProviderAuthScheme, ProviderCapability, ProviderKind, ProviderTransport } from '../schema/provider-contract';
import type { ProviderModelRuntime, ProviderProbeProfileRuntime, ProviderSmokeResult } from '../schema/provider-runtime';
import type { RuntimeSnapshot } from '../schema/runtime-core';
import type { ModelPreset, ProviderTemplate } from '../schema/provider-template';
import {
  fetchProviderModels,
  getProviderSecretStatus,
  readProviderSecret,
  runProviderProbe,
  runProviderSmoke,
  saveProviderSecret,
} from '../runtime/provider-runtime';
import { resolveRuntimeBridgeStatus } from '../runtime/runtime-status';
import { isTauriRuntime } from '../runtime/tauri-runtime';
import { useAppStore } from '../stores/app-store';
import { buildDefaultSceneModelAssignments, buildProviderDraftPatchFromTemplate, buildProviderVerificationPatch } from '../utils/provider-draft';
import {
  buildProviderTemplateCatalogEntries,
  persistProviderTemplateCatalogEntries,
  readProviderTemplateCatalogPreferences,
  type ProviderTemplateCatalogEntry,
  type ProviderTemplateCatalogPreference,
} from '../utils/provider-template-catalog';
import {
  createCustomProviderTemplate,
  customProviderTemplateToDraft,
  readCustomProviderTemplates,
  type CustomProviderTemplateDraft,
  updateCustomProviderTemplate,
  writeCustomProviderTemplates,
} from '../utils/custom-provider-templates';
import {
  capabilityForScenario,
  createProviderModelCapabilityRegistryEntry,
  formatProviderCapabilityLabel,
  normalizeProviderCapabilityList,
  normalizeProviderModel,
  normalizeProviderModels,
  providerCapabilityOrder,
  resolveProviderModelCapabilities,
} from '../utils/provider-model-capabilities';
import { getProbeVerdictLabel, getProbeVerdictTone, resolveProbeView } from '../utils/provider-probe';

type ModelCatalogState = {
  signature: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  source: 'runtime' | 'preset';
  models: ProviderModelRuntime[];
  error: string | null;
  fetchedAt: string | null;
  endpoint: string | null;
};

type ModelCatalogScenarioFilter = 'all' | ProviderScenario;

const providerScenarioOrder: ProviderScenario[] = ['watch', 'game', 'voice-room', 'subtitle-translate'];

function formatProviderLabel(displayName: string) {
  return displayName.replace(/\s*API\s*/gi, ' ').replace(/\s{2,}/g, ' ').trim();
}

function formatTransportLabel(transport: ProviderTransport | string) {
  if (transport === 'streaming-http') {
    return '流式HTTP';
  }

  if (transport === 'websocket') {
    return '长连接';
  }

  return '普通HTTP';
}

function formatScenarioLabel(scenario: AudioRouteMode | ProviderScenario) {
  if (scenario === 'watch') {
    return '语音转文字';
  }

  if (scenario === 'game') {
    return '文字转语音';
  }

  if (scenario === 'voice-room') {
    return '语音转语音（语音翻译）';
  }

  if (scenario === 'subtitle-translate') {
    return '字幕翻译';
  }

  return scenario;
}

function formatTimestampLabel(value: string | null) {
  if (!value) {
    return null;
  }

  let timestampMs: number | null = null;

  if (value.startsWith('unix:')) {
    const raw = Number(value.slice(5));
    timestampMs = Number.isFinite(raw) ? raw * 1000 : null;
  } else if (/^\d{10}$/.test(value)) {
    timestampMs = Number(value) * 1000;
  } else if (/^\d{13}$/.test(value)) {
    timestampMs = Number(value);
  } else {
    const parsed = Date.parse(value);
    timestampMs = Number.isNaN(parsed) ? null : parsed;
  }

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
  return status === 'completed' ? '完成' : '失败';
}

function formatSubtitlePriorityLabel(priority: string) {
  return priority === 'subtitle-first' ? '字幕优先' : '均衡';
}

function formatRuntimeErrorMessage(message: string, error?: unknown) {
  if (error instanceof Error && error.message) {
    return `${message}：${error.message}`;
  }

  if (typeof error === 'string' && error) {
    return `${message}：${error}`;
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
  return source === 'runtime' ? '实时目录' : '预置回退';
}

function defaultBaseUrlForKind(kind: ProviderKind) {
  if (kind === 'dashscope') {
    return 'https://dashscope.aliyuncs.com/api/v1';
  }

  return 'https://api.openai.com/v1';
}

function defaultCompatibleDashscopeBaseUrl() {
  return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
}

function supportedTransportsForKind(kind: ProviderKind): ProviderTransport[] {
  return kind === 'dashscope' ? ['http', 'websocket'] : ['http', 'streaming-http'];
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

    return template.defaultDraft.kind === 'dashscope' ? template.defaultDraft.baseUrl : defaultBaseUrlForKind('dashscope');
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

function ProvidersPage() {
  const configDraft = useAppStore((state) => state.configDraft);
  const runtimeSnapshot = useAppStore((state) => state.runtimeSnapshot);
  const audioRuntimeSnapshot = useAppStore((state) => state.audioRuntimeSnapshot);
  const runtimeNotifications = useAppStore((state) => state.runtimeNotifications);
  const updateActiveProviderDraft = useAppStore((state) => state.updateActiveProviderDraft);
  const updateDiagnosticsDraft = useAppStore((state) => state.updateDiagnosticsDraft);
  const setRuntimeSnapshot = useAppStore((state) => state.setRuntimeSnapshot);
  const updateProviders = useAppStore((state) => state.updateProviders);
  const updateActiveProviderTemplateId = useAppStore((state) => state.updateActiveProviderTemplateId);

  const activeProvider = useMemo(
    () => configDraft.providers.find((p) => p.templateId === configDraft.activeProviderTemplateId) ?? configDraft.providers[0],
    [configDraft.providers, configDraft.activeProviderTemplateId],
  );

  const [customTemplates, setCustomTemplates] = useState<ProviderTemplate[]>([]);
  const [templateCatalogPreferences, setTemplateCatalogPreferences] = useState<ProviderTemplateCatalogPreference[]>([]);
  const [secretDraft, setSecretDraft] = useState('');
  const [secretStored, setSecretStored] = useState(false);
  const [busyAction, setBusyAction] = useState<'secret' | 'secret-reveal' | 'verify' | null>(null);
  const [probeResult, setProbeResult] = useState<ProviderProbeProfileRuntime | null>(null);
  const [smokeResult, setSmokeResult] = useState<ProviderSmokeResult | null>(null);
  const [secretStatusMessage, setSecretStatusMessage] = useState<string | null>(null);
  const [secretVisible, setSecretVisible] = useState(false);
  const [sampleText, setSampleText] = useState('请把这句中文翻译成自然、简洁的英文口语。');
  const [templateQuery, setTemplateQuery] = useState('');
  const [customProviderDialogOpen, setCustomProviderDialogOpen] = useState(false);
  const [customProviderDraft, setCustomProviderDraft] = useState<CustomProviderTemplateDraft>(() => createDefaultCustomProviderDraft());
  const [customProviderError, setCustomProviderError] = useState<string | null>(null);
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  const [modelCatalogModalOpen, setModelCatalogModalOpen] = useState(false);
  const [capabilityRegistryModalOpen, setCapabilityRegistryModalOpen] = useState(false);
  const [verificationModalOpen, setVerificationModalOpen] = useState(false);
  const [selectedCatalogScenario, setSelectedCatalogScenario] = useState<ModelCatalogScenarioFilter>('all');
  const [modelCatalogTargetScenario, setModelCatalogTargetScenario] = useState<ProviderScenario>('watch');
  const [draggingTemplateId, setDraggingTemplateId] = useState<string | null>(null);
  const [draggingSceneModel, setDraggingSceneModel] = useState<{ scenario: ProviderScenario; modelId: string } | null>(null);
  const draggingTemplateIdRef = useRef<string | null>(null);
  const templateMouseDragMovedRef = useRef(false);
  const templateMouseHoverTargetRef = useRef<string | null>(null);
  const [manualModelIdDraft, setManualModelIdDraft] = useState('');
  const [modelCatalogQuery, setModelCatalogQuery] = useState('');
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogState>(() => createEmptyModelCatalog(buildModelCatalogSignature(activeProvider)));

  const storagePollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const storagePollAttemptsRef = useRef(0);
  const [storagePollError, setStoragePollError] = useState<string | null>(null);
  const STORAGE_POLL_INTERVAL_MS = 2000;
  const STORAGE_POLL_MAX_ATTEMPTS = 8;
  const STORAGE_POLL_INVOKE_TIMEOUT_MS = 5000;

  const allTemplateEntries = useMemo(
    () => buildProviderTemplateCatalogEntries([...providerTemplates, ...customTemplates], templateCatalogPreferences),
    [customTemplates, templateCatalogPreferences],
  );
  const visibleTemplateEntries = useMemo(() => allTemplateEntries.filter((entry) => !entry.hidden), [allTemplateEntries]);
  const allTemplates = useMemo(() => allTemplateEntries.map((item) => item.template), [allTemplateEntries]);
  const activeTemplateEntry = allTemplateEntries.find((item) => item.template.id === activeProvider.templateId);
  const activeTemplate = activeTemplateEntry?.template ?? defaultProviderTemplate;
  const activeProbe = useMemo(() => resolveProbeView(activeProvider, probeResult), [activeProvider, probeResult]);
  const effectiveBridgeStatus = resolveRuntimeBridgeStatus(runtimeSnapshot);
  const storageBlocked = isTauriRuntime() && runtimeSnapshot.storage.status !== 'ready';
  const providerRuntimeBlocked = storageBlocked;
  const latestRuntimeError = runtimeNotifications.find((item) => item.level === 'error');
  const modelCatalogSignature = useMemo(() => buildModelCatalogSignature(activeProvider), [activeProvider]);
  const localModelCapabilityRegistry = useMemo(
    () => activeProvider.localModelCapabilityRegistry ?? [],
    [activeProvider.localModelCapabilityRegistry],
  );
  const sceneAssignments = useMemo(
    () => ensureSceneAssignments(activeProvider.sceneModelAssignments),
    [activeProvider.sceneModelAssignments],
  );
  const modelLookup = useMemo(() => {
    const entries = dedupeModels([
      ...modelCatalog.models,
      ...buildFallbackModels(activeTemplate, activeProvider.model, localModelCapabilityRegistry, activeProvider.baseUrl),
    ]);
    return new Map(entries.map((model) => [model.id, model]));
  }, [activeTemplate, activeProvider.baseUrl, activeProvider.model, localModelCapabilityRegistry, modelCatalog.models]);

  const activeCustomTemplateDraft = useMemo(
    () => (activeTemplate.source === 'custom' ? customProviderTemplateToDraft(activeTemplate) : null),
    [activeTemplate],
  );
  const providerDraftForCustomTemplate = useMemo(
    () => providerDraftToCustomProviderTemplateDraft(activeProvider),
    [activeProvider],
  );

  useEffect(() => {
    if (activeTemplate.source !== 'custom' || !activeCustomTemplateDraft) {
      return;
    }

    const currentSignature = JSON.stringify(activeCustomTemplateDraft);
    const nextSignature = JSON.stringify(providerDraftForCustomTemplate);

    if (currentSignature === nextSignature) {
      return;
    }

    const nextTemplate = updateCustomProviderTemplate(activeTemplate, providerDraftForCustomTemplate);
    const nextTemplates = customTemplates.map((template) => (template.id === activeTemplate.id ? nextTemplate : template));

    writeCustomProviderTemplates(nextTemplates);
    setCustomTemplates(nextTemplates);
  }, [activeCustomTemplateDraft, activeTemplate, customTemplates, providerDraftForCustomTemplate]);

  useEffect(() => {
    setCustomTemplates(readCustomProviderTemplates());
    setTemplateCatalogPreferences(readProviderTemplateCatalogPreferences());
  }, []);

  const filteredTemplateEntries = useMemo(() => {
    const normalizedQuery = templateQuery.trim().toLowerCase();

    if (!normalizedQuery) {
      return visibleTemplateEntries;
    }

    return visibleTemplateEntries.filter(({ template }) => {
      const haystack = [
        template.displayName,
        template.description,
        template.notes,
        template.protocolLabel,
        ...template.presetModels.map((modelPreset) => `${modelPreset.displayName} ${modelPreset.model}`),
      ]
        .join(' ')
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }, [templateQuery, visibleTemplateEntries]);

  const filteredCatalogModels = useMemo(() => {
    const normalizedQuery = modelCatalogQuery.trim().toLowerCase();
    const scenarioMatchedModels =
      selectedCatalogScenario === 'all'
        ? modelCatalog.models
        : modelCatalog.models.filter((model) => model.capabilities.includes(capabilityForScenario(selectedCatalogScenario)));
    const filteredByScenario =
      selectedCatalogScenario !== 'all' && scenarioMatchedModels.length === 0 && modelCatalog.models.length > 0
        ? modelCatalog.models
        : scenarioMatchedModels;

    if (!normalizedQuery) {
      return filteredByScenario;
    }

    return filteredByScenario.filter((model) => {
      const haystack = [
        model.id,
        model.displayName,
        model.ownedBy ?? '',
        ...model.capabilities,
      ]
        .join(' ')
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }, [modelCatalog.models, modelCatalogQuery, selectedCatalogScenario]);
  const scenarioFilterHasMatches = useMemo(
    () =>
      selectedCatalogScenario === 'all' ||
      modelCatalog.models.some((model) => model.capabilities.includes(capabilityForScenario(selectedCatalogScenario))),
    [modelCatalog.models, selectedCatalogScenario],
  );

  const catalogSections = useMemo(
    () =>
      (selectedCatalogScenario === 'all' || !scenarioFilterHasMatches ? providerCapabilityOrder : [capabilityForScenario(selectedCatalogScenario)])
        .map((capability) => ({
          capability,
          models: filteredCatalogModels.filter((model) => model.capabilities.includes(capability)),
        }))
        .filter((section) => section.models.length > 0),
    [filteredCatalogModels, scenarioFilterHasMatches, selectedCatalogScenario],
  );
  const uncategorizedCatalogModels = useMemo(
    () => (selectedCatalogScenario === 'all' ? filteredCatalogModels.filter((model) => model.capabilities.length === 0) : []),
    [filteredCatalogModels, selectedCatalogScenario],
  );
  const modelCatalogDescription =
    `为${formatScenarioLabel(modelCatalogTargetScenario)}场景添加模型`;

  const providerRuntimeStatusMessage = useMemo(() => {
    if (effectiveBridgeStatus === 'runtime-error') {
      return latestRuntimeError?.message ?? '桌面运行时初始化失败，暂时无法读取或保存密钥。请先恢复 Rust Core 与存储层。';
    }

    if (storageBlocked) {
      const storageDetail =
        runtimeSnapshot.storage.credentialBackend === 'browser-preview'
          ? `存储层尚未就绪（当前为预览模式，schema v${runtimeSnapshot.storage.schemaVersion}）`
          : `存储层尚未就绪（状态=${runtimeSnapshot.storage.status}，backend=${runtimeSnapshot.storage.credentialBackend}，schema v${runtimeSnapshot.storage.schemaVersion}）`;
      return `${storageDetail}，配置读写、密钥管理与模型探测已暂挂。请在桌面壳中等待存储层自动初始化，或通过诊断面板排查。`;
    }

    return null;
  }, [effectiveBridgeStatus, latestRuntimeError, runtimeSnapshot.storage, storageBlocked]);

  function blockedActionMessage(action: string): string {
    if (effectiveBridgeStatus === 'runtime-error') {
      return latestRuntimeError?.message ?? `桌面运行时初始化失败，暂时无法${action}。`;
    }

    return `存储层未就绪，暂时无法${action}。`;
  }

  useEffect(() => {
    if (!isTauriRuntime() || runtimeSnapshot.storage.status === 'ready' || effectiveBridgeStatus === 'runtime-error') {
      setStoragePollError(null);

      return;
    }

    let active = true;
    storagePollAttemptsRef.current = 0;
    setStoragePollError(null);

    async function invokeWithTimeout<T>(command: string): Promise<T> {
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error(`invoke ${command} timed out after ${STORAGE_POLL_INVOKE_TIMEOUT_MS}ms`));
        }, STORAGE_POLL_INVOKE_TIMEOUT_MS);

        invoke<T>(command)
          .then((result) => {
            clearTimeout(timeoutId);
            resolve(result);
          })
          .catch((error) => {
            clearTimeout(timeoutId);
            reject(error);
          });
      });
    }

    const refresh = async (isLastResort = false) => {
      if (!active) return;

      try {
        if (isLastResort) {
          const snapshot = await invokeWithTimeout<RuntimeSnapshot>('bootstrap_runtime');

          if (active && snapshot.storage.status === 'ready') {
            setRuntimeSnapshot(snapshot);
            setStoragePollError(null);
          }
        } else {
          await invokeWithTimeout('bootstrap_storage');
          const snapshot = await invokeWithTimeout<RuntimeSnapshot>('get_runtime_snapshot');

          if (active && snapshot.storage.status === 'ready') {
            setRuntimeSnapshot(snapshot);
            setStoragePollError(null);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (active) {
          setStoragePollError(message);
        }

        console.error('[omni][ProvidersPage] storage recovery failed:', message);
      }
    };

    void refresh();

    storagePollIntervalRef.current = setInterval(() => {
      storagePollAttemptsRef.current += 1;

      if (storagePollAttemptsRef.current >= STORAGE_POLL_MAX_ATTEMPTS) {
        if (storagePollIntervalRef.current !== null) {
          clearInterval(storagePollIntervalRef.current);
          storagePollIntervalRef.current = null;
        }

        void refresh(true);

        return;
      }

      void refresh();
    }, STORAGE_POLL_INTERVAL_MS);

    return () => {
      active = false;

      if (storagePollIntervalRef.current !== null) {
        clearInterval(storagePollIntervalRef.current);
        storagePollIntervalRef.current = null;
      }
    };
  }, [effectiveBridgeStatus, runtimeSnapshot.storage.status, setRuntimeSnapshot]);

  const syncProviderProbeState = (result: ProviderProbeProfileRuntime) => {
    const nextPatch = buildProviderVerificationPatch(result);

    setProbeResult(result);
    updateActiveProviderDraft(nextPatch);
    updateDiagnosticsDraft({ providerStatus: nextPatch.status });
  };

  const markProviderVerificationWarning = () => {
    updateActiveProviderDraft({ status: 'warning' });
    updateDiagnosticsDraft({ providerStatus: 'warning' });
  };

  const refreshProviderSecretStatus = async (reference: string) => {
    const status = await getProviderSecretStatus(reference);
    setSecretStored(status.hasSecret);

    return status;
  };

  const runProviderVerification = async () => {
    const result = await runProviderProbe(activeProvider);
    syncProviderProbeState(result);

    return result;
  };

  useEffect(() => {
    let active = true;

    setSecretDraft('');
    setSecretVisible(false);

    if (providerRuntimeBlocked) {
      setSecretStored(false);
      setSecretStatusMessage(providerRuntimeStatusMessage);
      return () => {
        active = false;
      };
    }

    void refreshProviderSecretStatus(activeProvider.authRef.reference)
      .then(() => {
        if (active) {
          setSecretStatusMessage(null);
        }
      })
      .catch((error) => {
        if (active) {
          setSecretStored(false);
          setSecretStatusMessage(formatRuntimeErrorMessage('无法读取当前密钥状态', error));
        }
      });

    return () => {
      active = false;
    };
  }, [activeProvider.authRef.reference, providerRuntimeBlocked, providerRuntimeStatusMessage]);

  const syncModelCatalogCache = (cache: ProviderModelCatalogCache) => {
    updateActiveProviderDraft({ modelCatalogCache: cache });
    syncProviderInArray({ ...getActiveProviderFromState(), modelCatalogCache: cache } as ProviderDraft);
  };

  const refreshModelCatalog = async (force = false) => {
    const emptyState = createEmptyModelCatalog(
      modelCatalogSignature,
    );

    if (providerRuntimeBlocked) {
      setModelCatalog(createEmptyModelCatalog(modelCatalogSignature, 'error', providerRuntimeStatusMessage ?? blockedActionMessage('获取模型列表')));
      return;
    }

    setModelCatalog((current) => ({
      ...current,
      status: 'loading',
      error: null,
    }));

    try {
      const catalog = await fetchProviderModels(activeProvider, []);
      const runtimeModels = normalizeProviderModels(catalog.models, localModelCapabilityRegistry);
      const error = catalog.error?.message ?? (runtimeModels.length === 0 ? '上游未返回模型目录。' : null);
      const cache = buildModelCatalogCache(modelCatalogSignature, 'runtime', runtimeModels, catalog.endpoint, catalog.fetchedAt, error, activeProvider.templateId, activeProvider.displayName);
      syncModelCatalogCache(cache);
      setModelCatalog({
        signature: modelCatalogSignature,
        status: error ? 'error' : 'ready',
        source: 'runtime',
        models: runtimeModels,
        error,
        fetchedAt: catalog.fetchedAt,
        endpoint: catalog.endpoint,
      });
    } catch (error) {
      setModelCatalog(createEmptyModelCatalog(modelCatalogSignature, 'error', formatRuntimeErrorMessage('获取模型列表失败', error)));
    }
  };

  useEffect(() => {
    if (hasCachedModelCatalog(activeProvider.modelCatalogCache, modelCatalogSignature)) {
      setModelCatalog((current) =>
        current.signature === modelCatalogSignature && current.status === 'loading'
          ? current
          : buildModelCatalogStateFromCache(
              modelCatalogSignature,
              activeProvider.modelCatalogCache,
              activeTemplate,
              activeProvider.model,
              localModelCapabilityRegistry,
              activeProvider.baseUrl,
            ),
      );
      return;
    }

    setModelCatalog((current) =>
      current.signature === modelCatalogSignature
        ? current
        : createEmptyModelCatalog(modelCatalogSignature),
    );
  }, [
    activeTemplate.id,
    activeProvider.baseUrl,
    activeProvider.authRef.reference,
    activeProvider.kind,
    activeProvider.model,
    activeProvider.modelCatalogCache,
    localModelCapabilityRegistry,
    modelCatalogSignature,
    providerRuntimeBlocked,
  ]);

  useEffect(() => {
    setModelCatalog((current) => ({
      ...current,
      signature: modelCatalogSignature,
    }));
  }, [modelCatalogSignature]);

  const applyTemplate = (template: ProviderTemplate) => {
    const currentTemplateId = configDraft.activeProviderTemplateId;
    const isSameTemplate = currentTemplateId === template.id;

    if (isSameTemplate) {
      return;
    }

    // Save current active provider's scene assignments to global cache.
    if (currentTemplateId) {
      globalTemplateSceneAssignments.set(currentTemplateId, sceneAssignments);
    }

    // Persist the current active provider's state into the providers array.
    const currentProviders = [...useAppStore.getState().configDraft.providers];
    const oldIdx = currentProviders.findIndex((p) => p.templateId === currentTemplateId);
    if (oldIdx >= 0) {
      currentProviders[oldIdx] = { ...activeProvider, sceneModelAssignments: sceneAssignments };
    }

    // Ensure the new template exists in providers, or add it with defaults.
    const existingIdx = currentProviders.findIndex((p) => p.templateId === template.id);
    if (existingIdx < 0) {
      const savedAssignments = globalTemplateSceneAssignments.get(template.id);
      currentProviders.push({
        ...buildProviderDraftPatchFromTemplate(activeProvider, template),
        sceneModelAssignments: savedAssignments
          ? ensureSceneAssignments(savedAssignments)
          : buildDefaultSceneModelAssignments(template),
        model: template.defaultDraft.model,
        status: 'draft',
      } as ProviderDraft);
    }
    updateProviders(currentProviders);

    // Switch the active provider template.
    updateActiveProviderTemplateId(template.id);

    // Restore scene assignments.
    const savedAssignments = globalTemplateSceneAssignments.get(template.id);
    if (savedAssignments) {
      updateActiveProviderDraft({ sceneModelAssignments: ensureSceneAssignments(savedAssignments), status: 'draft' });
    } else if (existingIdx < 0) {
      // Already set defaults above, nothing more needed for new provider.
    } else {
      const existing = currentProviders[existingIdx];
      if (existing.sceneModelAssignments?.length) {
        updateActiveProviderDraft({ sceneModelAssignments: ensureSceneAssignments(existing.sceneModelAssignments), status: 'draft' });
      } else {
        updateActiveProviderDraft({
          sceneModelAssignments: buildDefaultSceneModelAssignments(template),
          model: template.defaultDraft.model,
          status: 'draft',
        });
      }
    }

    updateDiagnosticsDraft({ providerStatus: 'draft' });
    setProbeResult(null);
    setSmokeResult(null);
    setSecretDraft('');
    setSecretStatusMessage(null);
    setSecretVisible(false);
    setModelCatalog(
      createFallbackModelCatalog(
        modelCatalogSignature,
        template,
        template.defaultDraft.model,
        activeProvider.localModelCapabilityRegistry ?? [],
        template.defaultDraft.baseUrl,
      ),
    );
  };

  const handleTemplateApply = (templateId: string) => {
    const template = allTemplates.find((item) => item.id === templateId);

    if (!template) {
      return;
    }

    applyTemplate(template);
  };

  const handleSecretSave = async () => {
    if (!secretDraft.trim() && !activeProvider.baseUrl.trim()) {
      return;
    }

    if (providerRuntimeBlocked) {
      setSecretStatusMessage(providerRuntimeStatusMessage ?? blockedActionMessage('保存密钥'));
      return;
    }

    setBusyAction('secret');
    try {
      if (secretDraft.trim()) {
        await saveProviderSecret(activeProvider.authRef.reference, secretDraft.trim());
        setSecretStored(true);
        setSecretDraft('');
        setSecretVisible(false);
      }
      setSecretStatusMessage('认证与入口已保存。密钥会写入系统凭据管理器，API 地址会随配置保存。');
      void refreshModelCatalog(true);
    } catch (error) {
      setSecretStatusMessage(formatRuntimeErrorMessage('密钥写入失败', error));
      markProviderVerificationWarning();
    } finally {
      setBusyAction(null);
    }
  };

  const handleSecretVisibilityToggle = async () => {
    if (secretVisible) {
      setSecretVisible(false);
      return;
    }

    if (providerRuntimeBlocked) {
      setSecretStatusMessage(providerRuntimeStatusMessage ?? blockedActionMessage('读取密钥'));
      return;
    }

    if (secretDraft) {
      setSecretVisible(true);
      return;
    }

    setBusyAction('secret-reveal');
    try {
      const payload = await readProviderSecret(activeProvider.authRef.reference);

      if (!payload.secret) {
        setSecretStored(false);
        setSecretStatusMessage('当前认证引用下没有已保存密钥，无法显示明文。');
        return;
      }

      setSecretDraft(payload.secret);
      setSecretStored(true);
      setSecretVisible(true);
      setSecretStatusMessage('已从系统凭据管理器读取当前密钥明文。');
    } catch (error) {
      setSecretStatusMessage(formatRuntimeErrorMessage('读取密钥明文失败', error));
    } finally {
      setBusyAction(null);
    }
  };

  const handleVerificationRun = async () => {
    if (providerRuntimeBlocked) {
      setSecretStatusMessage(providerRuntimeStatusMessage ?? blockedActionMessage('验证接入'));
      return;
    }

    setBusyAction('verify');
    try {
      const probe = await runProviderVerification();

      if (probe.error) {
        setSmokeResult(null);
        setVerificationModalOpen(true);
        return;
      }

      const result = await runProviderSmoke(
        activeProvider,
        sampleText,
        configDraft.subtitles.sourceLanguage,
        configDraft.subtitles.targetLanguage,
      );
      setSmokeResult(result);

      if (result.error) {
        updateActiveProviderDraft({ status: 'warning' });
        updateDiagnosticsDraft({ providerStatus: 'warning' });
        setVerificationModalOpen(true);
        return;
      }

      updateActiveProviderDraft({ status: result.streamObserved ? 'ready' : 'warning' });
      updateDiagnosticsDraft({ providerStatus: result.streamObserved ? 'ready' : 'warning' });
      setVerificationModalOpen(true);
    } catch (error) {
      setSecretStatusMessage(formatRuntimeErrorMessage('验证接入失败', error));
      updateActiveProviderDraft({ status: 'warning' });
      updateDiagnosticsDraft({ providerStatus: 'warning' });
    } finally {
      setBusyAction(null);
    }
  };

  const openCreateCustomProviderDialog = () => {
    setCustomProviderDraft(createDefaultCustomProviderDraft());
    setCustomProviderError(null);
    setCustomProviderDialogOpen(true);
  };

  const closeCustomProviderDialog = () => {
    setCustomProviderDialogOpen(false);
    setCustomProviderError(null);
  };

  const handleCustomProviderKindChange = (kind: ProviderKind) => {
    setCustomProviderDraft((current) => ({
      ...current,
      kind,
      baseUrl: defaultBaseUrlForKind(kind),
      transport: defaultTransportForKind(kind),
      region: kind === 'dashscope' ? current.region || 'cn-beijing' : '',
      systemPromptTemplate: defaultPromptTemplateForKind(kind),
    }));
  };

  const handleProviderKindChange = (kind: ProviderKind) => {
    if (kind === activeProvider.kind) {
      return;
    }

    const nextSupportedTransports = supportedTransportsForKind(kind);
    const nextTransport = nextSupportedTransports.includes(activeProvider.transport)
      ? activeProvider.transport
      : defaultTransportForKind(kind);

    updateActiveProviderDraft({
      kind,
      baseUrl: resolveBaseUrlForApiFormat(kind, activeProvider.baseUrl, activeTemplate),
      transport: nextTransport,
      region: kind === 'dashscope' ? activeProvider.region || 'cn-beijing' : undefined,
      modelCatalogCache: createEmptyModelCatalogCache(),
      status: 'draft',
    });
    setProbeResult(null);
    setSmokeResult(null);
    setModelCatalog(
      createFallbackModelCatalog(
        modelCatalogSignature,
        activeTemplate,
        activeProvider.model,
        localModelCapabilityRegistry,
        activeProvider.baseUrl,
      ),
    );
  };

  const handleCustomProviderSave = () => {
    if (!customProviderDraft.displayName.trim()) {
      setCustomProviderError('请先填写平台名称。');
      return;
    }

    if (!customProviderDraft.baseUrl.trim()) {
      setCustomProviderError('请先填写接口地址。');
      return;
    }

    const nextTemplates = [...customTemplates, createCustomProviderTemplate(customProviderDraft)];
    const activeCustomTemplate = nextTemplates[nextTemplates.length - 1];

    writeCustomProviderTemplates(nextTemplates);
    setCustomTemplates(nextTemplates);

    applyTemplate(activeCustomTemplate);

    setTemplateQuery('');
    closeCustomProviderDialog();
  };

  const handleDeleteActiveCustomProvider = () => {
    if (activeTemplate.source !== 'custom') {
      const nextEntries = allTemplateEntries.map((entry) =>
        entry.template.id === activeTemplate.id ? { ...entry, enabled: false, hidden: true } : entry,
      );
      const fallbackTemplate = nextEntries.find((entry) => !entry.hidden && entry.template.id !== activeTemplate.id)?.template;

      if (!fallbackTemplate) {
        setSecretStatusMessage('至少需要保留一个可用平台，当前平台未删除。');
        return;
      }

      updateTemplateCatalogEntries(nextEntries);
      applyTemplate(fallbackTemplate);
      setSecretStatusMessage('已从本机平台目录隐藏当前预设平台。');
      return;
    }

    const nextTemplates = customTemplates.filter((template) => template.id !== activeTemplate.id);
    const nextEntries = buildProviderTemplateCatalogEntries([...providerTemplates, ...nextTemplates], templateCatalogPreferences);
    const fallbackTemplate = nextEntries.find((entry) => !entry.hidden && entry.template.id !== activeTemplate.id)?.template;

    if (!fallbackTemplate) {
      setSecretStatusMessage('至少需要保留一个可用平台，当前平台未删除。');
      return;
    }

    writeCustomProviderTemplates(nextTemplates);
    setCustomTemplates(nextTemplates);
    applyTemplate(fallbackTemplate);
    updateProviders(
      useAppStore.getState().configDraft.providers.filter((provider) => provider.templateId !== activeTemplate.id),
    );
    setSecretStatusMessage('已删除当前自定义平台，并切回默认模板。');
  };

  const updateTemplateCatalogEntries = (entries: ProviderTemplateCatalogEntry[]) => {
    const nextPreferences = entries.map((entry, index) => ({
      templateId: entry.template.id,
      enabled: entry.enabled,
      hidden: entry.hidden,
      order: index,
    }));

    setTemplateCatalogPreferences(nextPreferences);
    persistProviderTemplateCatalogEntries(entries);
  };

  const handleTemplateEnabledToggle = (templateId: string) => {
    const nextEntries = allTemplateEntries.map((entry) =>
      entry.template.id === templateId ? { ...entry, enabled: !entry.enabled } : entry,
    );

    updateTemplateCatalogEntries(nextEntries);
  };

  const handleTemplateReorder = (sourceTemplateId: string, targetTemplateId: string) => {
    const entries = reorderTemplateEntries(allTemplateEntries, sourceTemplateId, targetTemplateId);
    if (entries !== allTemplateEntries) {
      updateTemplateCatalogEntries(entries);
    }
  };

  const handleTemplateMouseDown = (event: MouseEvent<HTMLButtonElement>, templateId: string) => {
    if (event.button !== 0) {
      return;
    }

    templateMouseDragMovedRef.current = false;
    templateMouseHoverTargetRef.current = null;
    draggingTemplateIdRef.current = templateId;
    setDraggingTemplateId(templateId);
  };

  const handleTemplateMouseOver = (event: MouseEvent<HTMLButtonElement>, targetTemplateId: string) => {
    const sourceTemplateId = draggingTemplateIdRef.current;

    if (
      (event.buttons & 1) !== 1 ||
      !sourceTemplateId ||
      sourceTemplateId === targetTemplateId ||
      templateMouseHoverTargetRef.current === targetTemplateId
    ) {
      return;
    }

    templateMouseDragMovedRef.current = true;
    templateMouseHoverTargetRef.current = targetTemplateId;
    handleTemplateReorder(sourceTemplateId, targetTemplateId);
  };

  const handleTemplateMouseUp = () => {
    draggingTemplateIdRef.current = null;
    templateMouseHoverTargetRef.current = null;
    setDraggingTemplateId(null);
  };

  useEffect(() => {
    if (!draggingTemplateId) {
      return undefined;
    }

    const handleWindowMouseUp = () => {
      draggingTemplateIdRef.current = null;
      templateMouseHoverTargetRef.current = null;
      setDraggingTemplateId(null);
    };

    window.addEventListener('mouseup', handleWindowMouseUp);

    return () => {
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [draggingTemplateId]);

  const syncProviderInArray = (nextProvider: ProviderDraft) => {
    const currentProviders = [...useAppStore.getState().configDraft.providers];
    const existingIndex = currentProviders.findIndex((p) => p.templateId === nextProvider.templateId);
    if (existingIndex >= 0) {
      currentProviders[existingIndex] = { ...nextProvider };
      updateProviders(currentProviders);
    }
  };

  const updateSceneModelAssignments = (nextAssignments: ProviderSceneModelAssignment[], nextModel?: string) => {
    updateActiveProviderDraft({
      sceneModelAssignments: ensureSceneAssignments(nextAssignments),
      ...(nextModel ? { model: nextModel } : {}),
      status: 'draft',
    });
    syncProviderInArray({
      ...getActiveProviderFromState(),
      sceneModelAssignments: ensureSceneAssignments(nextAssignments),
      ...(nextModel ? { model: nextModel } : {}),
    } as ProviderDraft);
  };

  const isModelAddedToScenario = (scenario: ModelCatalogScenarioFilter, modelId: string) => {
    if (scenario === 'all') {
      return sceneAssignments.some((item) => item.modelIds.includes(modelId));
    }

    return sceneAssignments.find((item) => item.scenario === scenario)?.modelIds.includes(modelId) ?? false;
  };

  const handleModelCatalogOpen = (scenario?: ProviderScenario) => {
    const nextTargetScenario = scenario ?? configDraft.devices.routeMode;

    setModelCatalogTargetScenario(nextTargetScenario);
    setSelectedCatalogScenario(scenario ? scenario : 'all');
    setModelCatalogModalOpen(true);
    setModelCatalog(createEmptyModelCatalog(modelCatalogSignature, 'loading'));

    if (!providerRuntimeBlocked) {
      void refreshModelCatalog(true);
    } else {
      setModelCatalog(createEmptyModelCatalog(modelCatalogSignature, 'error', providerRuntimeStatusMessage ?? blockedActionMessage('获取模型列表')));
    }
  };

  const handleSceneModelAdd = (scenario: ProviderScenario, model: ProviderModelRuntime) => {
    const nextAssignments = addSceneModel(sceneAssignments, scenario, model.id);
    updateSceneModelAssignments(nextAssignments, scenario === configDraft.devices.routeMode ? model.id : undefined);
  };

  const handleManualModelAdd = () => {
    const modelId = manualModelIdDraft.trim();

    if (!modelId) {
      return;
    }

    const existingModel = modelLookup.get(modelId);

    handleSceneModelAdd(
      modelCatalogTargetScenario,
      existingModel ?? createDerivedRuntimeModel(modelId, localModelCapabilityRegistry, 'manual'),
    );
    setManualModelIdDraft('');
  };

  const handleSceneModelRemove = (scenario: ProviderScenario, modelId: string) => {
    const result = removeSceneModel(sceneAssignments, scenario, modelId, configDraft.devices.routeMode, activeProvider.model, activeTemplate.defaultDraft.model);
    updateSceneModelAssignments(result.assignments, result.nextModel);
  };

  const handleCatalogModelToggle = (scenario: ProviderScenario, model: ProviderModelRuntime) => {
    const added = isModelAddedToScenario(scenario, model.id);

    if (added) {
      handleSceneModelRemove(scenario, model.id);
      return;
    }

    handleSceneModelAdd(scenario, model);
  };

  const handleProviderCustomHeaderChange = (headerId: string, patch: Partial<ProviderCustomHeaderDraft>) => {
    updateActiveProviderDraft({
      customHeaders: activeProvider.customHeaders.map((item) => (item.id === headerId ? { ...item, ...patch } : item)),
      status: 'draft',
    });
  };

  const handleProviderCustomHeaderAdd = () => {
    updateActiveProviderDraft({
      customHeaders: [...activeProvider.customHeaders, createCustomHeaderDraft()],
      status: 'draft',
    });
  };

  const handleProviderCustomHeaderRemove = (headerId: string) => {
    updateActiveProviderDraft({
      customHeaders: activeProvider.customHeaders.filter((item) => item.id !== headerId),
      status: 'draft',
    });
  };

  const applyLocalModelCapabilityRegistry = (entries: ProviderModelCapabilityRegistryEntry[]) => {
    const nextEntries = entries.map((entry) => ({
      ...entry,
      modelId: entry.modelId.trim(),
      capabilities: normalizeProviderCapabilityList(entry.capabilities),
    }));

    updateActiveProviderDraft({
      localModelCapabilityRegistry: nextEntries,
      status: 'draft',
    });
    setModelCatalog((current) => ({
      ...current,
      models: normalizeProviderModels(current.models, nextEntries),
    }));
  };

  const handleCapabilityRegistryEntryAdd = (modelId = '') => {
    applyLocalModelCapabilityRegistry([
      ...localModelCapabilityRegistry,
      createProviderModelCapabilityRegistryEntry(modelId),
    ]);
  };

  const handleCapabilityRegistryEntryChange = (
    entryId: string,
    patch: Partial<ProviderModelCapabilityRegistryEntry>,
  ) => {
    applyLocalModelCapabilityRegistry(
      localModelCapabilityRegistry.map((entry) =>
        entry.id === entryId
          ? {
              ...entry,
              ...patch,
              capabilities: patch.capabilities ? normalizeProviderCapabilityList(patch.capabilities) : entry.capabilities,
            }
          : entry,
      ),
    );
  };

  const handleCapabilityRegistryEntryToggle = (entryId: string, capability: ProviderCapability) => {
    const currentEntry = localModelCapabilityRegistry.find((entry) => entry.id === entryId);

    if (!currentEntry) {
      return;
    }

    const nextCapabilities = currentEntry.capabilities.includes(capability)
      ? currentEntry.capabilities.filter((item) => item !== capability)
      : [...currentEntry.capabilities, capability];

    handleCapabilityRegistryEntryChange(entryId, { capabilities: nextCapabilities });
  };

  const handleCapabilityRegistryEntryRemove = (entryId: string) => {
    applyLocalModelCapabilityRegistry(localModelCapabilityRegistry.filter((entry) => entry.id !== entryId));
  };

  const handleResponseModalityToggle = (modality: ProviderResponseModality) => {
    updateActiveProviderDraft({
      responseModalities: toggleResponseModalities(activeProvider.responseModalities, modality),
      status: 'draft',
    });
  };

  const handleSceneModelReorder = (scenario: ProviderScenario, targetModelId: string) => {
    const nextAssignments = reorderSceneModels(sceneAssignments, draggingSceneModel, scenario, targetModelId);
    if (nextAssignments === sceneAssignments) {
      return;
    }
    updateSceneModelAssignments(nextAssignments);
  };

  const verificationSummaryTone: StatusTone = smokeResult
    ? smokeResult.error
      ? 'warning'
      : 'ready'
    : getProbeVerdictTone(activeProbe.verdict);

  const verificationSummaryLabel = smokeResult ? formatSmokeStatusLabel(smokeResult.status) : getProbeVerdictLabel(activeProbe.verdict);
  const hasVerificationDetail = probeResult !== null || smokeResult !== null;

  return (
    <div className="provider-console provider-console-compact">
      <aside className="provider-directory content-card page-card compact-card">
        <div className="provider-directory-header provider-directory-header-compact">
          <div>
            <span className="provider-directory-title">平台目录</span>
          </div>
        </div>

        <div className="provider-directory-search provider-directory-search-compact">
          <AppIcon name="search" size={14} />
          <input
            className="provider-directory-search-input"
            onChange={(event) => setTemplateQuery(event.target.value)}
            placeholder="搜索平台..."
            type="search"
            value={templateQuery}
          />
        </div>

        <div className="provider-directory-list" role="list">
          {filteredTemplateEntries.map((entry) => {
            const { enabled, template } = entry;

            return (
              <button
                className={`provider-directory-item provider-directory-item-compact${draggingTemplateId === template.id ? ' provider-directory-item-dragging' : ''}${activeProvider.templateId === template.id ? ' provider-directory-item-active' : ''}`}
                key={template.id}
                onMouseDown={(event) => handleTemplateMouseDown(event, template.id)}
                onMouseOver={(event) => handleTemplateMouseOver(event, template.id)}
                onMouseUp={handleTemplateMouseUp}
                onClick={() => {
                  if (templateMouseDragMovedRef.current) {
                    templateMouseDragMovedRef.current = false;
                    return;
                  }

                  handleTemplateApply(template.id);
                }}
                title="点击切换配置 | 左键拖动调整顺序"
                type="button"
              >
                <span className="provider-directory-item-icon" aria-hidden="true">
                  <AppIcon name={resolveTemplateIconName(template.defaultDraft.kind)} size={15} />
                </span>
                <span className="provider-directory-item-copy">
                  <strong>{formatProviderLabel(template.displayName)}</strong>
                </span>
                <span
                  className={enabled ? 'provider-directory-item-state provider-directory-item-state-active' : 'provider-directory-item-state'}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleTemplateEnabledToggle(template.id);
                  }}
                  title="点击切换启用状态"
                >
                  {enabled ? 'ON' : 'OFF'}
                </span>
              </button>
            );
          })}

          {filteredTemplateEntries.length === 0 ? (
            <div className="provider-directory-empty">
              <strong>没有匹配的平台</strong>
              <p>试试搜索平台名、模型名或协议关键字。</p>
            </div>
          ) : null}
        </div>

        {!modelCatalogModalOpen ? (
        <button className="provider-directory-add provider-directory-add-compact" onClick={openCreateCustomProviderDialog} type="button">
          <AppIcon name="cloud" size={14} />
          添加
        </button>
        ) : null}
      </aside>

      <section className="provider-studio">
        <header className="provider-studio-header content-card page-card compact-card provider-studio-header-compact">
          <PageSectionHeader
            actions={(
              <>
                <button className="provider-header-icon provider-header-icon-danger" onClick={handleDeleteActiveCustomProvider} title="删除当前平台" type="button">
                  <AppIcon name="trash" size={13} />
                </button>
              </>
            )}
            actionsClassName="provider-studio-header-actions provider-studio-header-actions-compact"
            className="provider-studio-heading-row provider-studio-heading-row-compact"
            copyClassName="provider-studio-heading-copy"
            title={activeTemplate.displayName}
            titleLevel="h2"
          />

          <div className="provider-studio-toolbar provider-studio-toolbar-compact">
            <div className="provider-action-row provider-action-row-compact">
              <button className="icon-button provider-primary-action" disabled={busyAction !== null || providerRuntimeBlocked} onClick={() => void handleVerificationRun()} type="button">
                <AppIcon name="activity" size={14} />
                {busyAction === 'verify' ? '验证中...' : '验证接入'}
              </button>
              {hasVerificationDetail ? (
                <button className="icon-button" onClick={() => setVerificationModalOpen(true)} type="button">
                  <AppIcon name="book" size={14} />
                  验证详情
                </button>
              ) : null}
              <button className="icon-button" onClick={() => handleModelCatalogOpen()} type="button">
                <AppIcon name="layers" size={14} />
                模型列表
              </button>
              <button className="icon-button" onClick={() => setAdvancedSettingsOpen(true)} type="button">
                <AppIcon name="sliders" size={14} />
                高级设置
              </button>
            </div>
          </div>

          {secretStatusMessage ? (
            <div
              className={`provider-inline-alert${
                secretStatusMessage === '已从系统凭据管理器读取当前密钥明文。' ? ' provider-inline-alert-plain' : ''
              }`}
            >
              {secretStatusMessage}
            </div>
          ) : null}
          {providerRuntimeStatusMessage && secretStatusMessage !== providerRuntimeStatusMessage ? (
            <div className="provider-inline-alert provider-inline-alert-warning">{providerRuntimeStatusMessage}</div>
          ) : null}
          {storagePollError ? <div className="provider-inline-alert provider-inline-alert-warning">存储恢复尝试失败：{storagePollError}</div> : null}
        </header>

        <div className="provider-studio-grid provider-studio-grid-compact provider-studio-grid-single">
          <div className="provider-studio-main">
            <article className="content-card page-card compact-card provider-panel-card provider-panel-card-compact">
              <div className="provider-panel-heading provider-panel-heading-compact">
                <div>
                  <h3>认证与入口</h3>
                </div>
                <StatusBadge label={secretStored ? '密钥已保存' : '待录入密钥'} tone={secretStored ? 'ready' : 'draft'} />
              </div>

              <div className="provider-setting-block provider-setting-block-compact">
                <div className="provider-setting-header provider-setting-header-compact">
                  <div>
                    <strong>API 密钥和 API 地址</strong>
                  </div>
                </div>
                <label className="field-stack provider-auth-entry-field">
                  <span>API 地址</span>
                  <div className="secret-input-inline provider-secret-input-inline">
                    <input className="text-input" onChange={(event) => updateActiveProviderDraft({ baseUrl: event.target.value, status: 'draft' })} value={activeProvider.baseUrl} />
                    <button className="icon-button secret-visibility-button" onClick={() => updateActiveProviderDraft({ baseUrl: activeTemplate.defaultDraft.baseUrl, status: 'draft' })} title="重置 API 地址" type="button">
                      <AppIcon name="refresh" size={14} />
                    </button>
                  </div>
                </label>
                <label className="field-stack provider-auth-entry-field">
                  <span>API 密钥</span>
                  <div className="provider-secret-row">
                    <div className="secret-input-inline provider-secret-input-inline">
                      <input
                        className="text-input"
                        onChange={(event) => setSecretDraft(event.target.value)}
                        onFocus={() => {
                          if (secretStored && !secretDraft) {
                            setSecretDraft('');
                          }
                        }}
                        placeholder="密钥"
                        type={secretVisible ? 'text' : 'password'}
                        value={secretStored && !secretDraft ? '***********************************' : secretDraft}
                      />
                      <button
                        aria-label={secretVisible ? '隐藏密钥' : '显示密钥'}
                        className="icon-button secret-visibility-button"
                        disabled={busyAction !== null || providerRuntimeBlocked}
                        onClick={() => void handleSecretVisibilityToggle()}
                        title={secretVisible ? '隐藏密钥' : '显示密钥'}
                        type="button"
                      >
                        <AppIcon name={secretVisible ? 'eye-off' : 'eye'} size={14} />
                      </button>
                    </div>
                  </div>
                </label>
                <div className="provider-auth-entry-actions">
                  <button className="action-button" disabled={busyAction !== null || (!secretDraft.trim() && !activeProvider.baseUrl.trim()) || providerRuntimeBlocked} onClick={() => void handleSecretSave()} type="button">
                    <AppIcon name="key" size={14} />
                    {busyAction === 'secret' ? '保存中...' : '保存认证与入口'}
                  </button>
                </div>
                <div className="provider-footnote-row">
                  {modelCatalog.endpoint ? <p className="provider-setting-footnote">模型端点：{modelCatalog.endpoint}</p> : null}
                </div>
              </div>
            </article>

            <article className="content-card page-card compact-card provider-panel-card provider-panel-card-compact">
              <div className="provider-panel-heading provider-panel-heading-compact">
                <div>
                  <h3>场景模型</h3>
                </div>
                <div className="provider-panel-tools">
                  <StatusBadge label={`${sceneAssignments.reduce((count, item) => count + item.modelIds.length, 0)} 个已添加模型`} tone="pending" />
                </div>
              </div>

              <div className="provider-scene-grid">
                {sceneAssignments.map((assignment) => {
                  const sceneModels = assignment.modelIds
                    .map((modelId) => modelLookup.get(modelId) ?? createDerivedRuntimeModel(modelId, localModelCapabilityRegistry))
                    .filter(Boolean);

                  return (
                    <article className="provider-scene-card" key={assignment.scenario}>
                      <div className="provider-scene-card-header">
                        <div>
                          <strong>{formatScenarioLabel(assignment.scenario)}</strong>
                          <p>{sceneModels.length > 0 ? `${sceneModels.length} 个已添加模型` : '尚未添加模型'}</p>
                        </div>
                        <button className="icon-button" onClick={() => handleModelCatalogOpen(assignment.scenario)} type="button">
                          <AppIcon name="cloud" size={14} />
                          添加模型
                        </button>
                      </div>

                      {sceneModels.length > 0 ? (
                        <div className="provider-scene-model-list">
                          {sceneModels.map((model) => (
                            <div
                              className="provider-scene-model-item"
                              draggable
                              key={`${assignment.scenario}-${model.id}`}
                              onDragEnd={() => setDraggingSceneModel(null)}
                              onDragOver={(event) => event.preventDefault()}
                              onDragStart={() => setDraggingSceneModel({ scenario: assignment.scenario, modelId: model.id })}
                              onDrop={() => handleSceneModelReorder(assignment.scenario, model.id)}
                            >
                              <div className="provider-scene-model-copy">
                                <strong>{model.displayName}</strong>
                                {model.displayName.trim() !== model.id.trim() ? <span>{model.id}</span> : null}
                              </div>
                              <div className="provider-scene-model-actions">
                                {model.capabilities.length > 0 ? (
                                  <div className="provider-chip-row provider-chip-row-compact provider-chip-row-tight">
                                    {model.capabilities.map((capability) => (
                                      <span className={`provider-meta-chip provider-capability-chip provider-capability-chip-${capability}`} key={`${model.id}-${capability}`}>
                                        <AppIcon name={resolveCapabilityIconName(capability)} size={12} />
                                        {formatProviderCapabilityLabel(capability)}
                                      </span>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="provider-setting-footnote">待确认</span>
                                )}
                                <button className="provider-header-icon provider-header-icon-danger" onClick={() => handleSceneModelRemove(assignment.scenario, model.id)} title="删除已添加模型" type="button">
                                  <AppIcon name="close" size={13} />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="provider-directory-empty provider-scene-empty">
                          <strong>当前场景还没有模型</strong>
                          <p>点击右上角“添加模型”后，可把模型放进这个场景。</p>
                        </div>
                      )}

                    </article>
                  );
                })}
              </div>
            </article>
          </div>
        </div>
      </section>

      {modelCatalogModalOpen ? (
        <div className="provider-modal-backdrop" onClick={() => setModelCatalogModalOpen(false)} role="presentation">
          <div aria-label="模型列表" aria-modal="true" className="provider-modal provider-model-modal content-card page-card compact-card" onClick={(event) => event.stopPropagation()} role="dialog">
            <div className="provider-panel-heading provider-panel-heading-compact">
              <div>
                <h3>模型列表</h3>
                <p>{modelCatalogDescription}</p>
              </div>
              <div className="provider-model-toolbar">
                <StatusBadge label={formatModelCatalogSourceLabel(modelCatalog.source)} tone={modelCatalog.source === 'runtime' ? 'ready' : 'draft'} />
                <StatusBadge label={`目标场景：${formatScenarioLabel(modelCatalogTargetScenario)}`} tone="pending" />
                <button className="provider-header-icon" onClick={() => setCapabilityRegistryModalOpen(true)} title="编辑能力注册表" type="button">
                  <AppIcon name="settings" size={14} />
                </button>
                <button className="provider-header-icon" onClick={() => void refreshModelCatalog(true)} title="刷新模型目录" type="button">
                  <AppIcon name="refresh" size={14} />
                </button>
                <button className="provider-header-icon" onClick={() => setModelCatalogModalOpen(false)} title="关闭模型列表" type="button">
                  <AppIcon name="close" size={13} />
                </button>
              </div>
            </div>

            <div className="provider-scenario-switcher">
              {(['all', ...providerScenarioOrder] as ModelCatalogScenarioFilter[]).map((scenario) => (
                <button
                  className={selectedCatalogScenario === scenario ? 'provider-scenario-pill provider-scenario-pill-active' : 'provider-scenario-pill'}
                  key={scenario}
                  onClick={() => setSelectedCatalogScenario(scenario)}
                  type="button"
                >
                  {scenario === 'all' ? '全部' : formatScenarioLabel(scenario)}
                </button>
              ))}
            </div>

            <div className="provider-directory-search provider-directory-search-compact">
              <AppIcon name="search" size={14} />
              <input
                className="provider-directory-search-input"
                onChange={(event) => setModelCatalogQuery(event.target.value)}
                placeholder="搜索模型..."
                type="search"
                value={modelCatalogQuery}
              />
            </div>

            {modelCatalog.error ? <div className="provider-inline-alert provider-inline-alert-warning">{modelCatalog.error}</div> : null}
            {modelCatalog.fetchedAt ? <p className="provider-setting-footnote">最近刷新：{formatTimestampLabel(modelCatalog.fetchedAt) ?? modelCatalog.fetchedAt}</p> : null}

            <div className="provider-model-list provider-model-list-modal">
              {catalogSections.map((section) => (
                <section className="provider-capability-section" key={section.capability}>
                  <div className="provider-capability-section-header">
                    <div className={`provider-capability-badge provider-capability-badge-${section.capability}`}>
                      <AppIcon name={resolveCapabilityIconName(section.capability)} size={14} />
                    </div>
                    <div>
                      <strong>{formatProviderCapabilityLabel(section.capability)}</strong>
                      <p>{section.models.length} 个模型</p>
                    </div>
                  </div>

                  <div className="provider-capability-section-list">
                    {section.models.map((modelPreset) => {
                      const added = isModelAddedToScenario(modelCatalogTargetScenario, modelPreset.id);

                      return (
                        <div className={added ? 'provider-model-item provider-model-item-active provider-model-item-compact' : 'provider-model-item provider-model-item-compact'} key={`${section.capability}-${modelPreset.id}`}>
                          <div className="provider-model-item-leading">
                            <span className="provider-model-item-icon" aria-hidden="true">
                              <AppIcon name={resolveModelIconName(modelPreset)} size={14} />
                            </span>
                            <div className="provider-model-item-copy">
                              <strong>{modelPreset.displayName}</strong>
                              {modelPreset.displayName.trim() !== modelPreset.id.trim() ? <span>{modelPreset.id}</span> : null}
                            </div>
                          </div>
                          <div className="provider-model-item-meta">
                            {modelPreset.capabilities.length > 0 ? (
                              <div className="provider-chip-row provider-chip-row-compact provider-chip-row-tight">
                                {modelPreset.capabilities.map((capability) => (
                                  <span className={`provider-meta-chip provider-capability-chip provider-capability-chip-${capability}`} key={`${modelPreset.id}-${capability}`}>
                                    <AppIcon name={resolveCapabilityIconName(capability)} size={12} />
                                    {formatProviderCapabilityLabel(capability)}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <span className="provider-setting-footnote">待确认，建议在能力注册表中补充。</span>
                            )}
                            <button
                              className={added ? 'icon-button provider-row-action provider-row-action-danger' : 'icon-button provider-row-action'}
                              onClick={() => handleCatalogModelToggle(modelCatalogTargetScenario, modelPreset)}
                              type="button"
                            >
                              {added ? '删除' : '添加'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}

              {uncategorizedCatalogModels.length > 0 ? (
                <section className="provider-capability-section" key="unclassified-models">
                  <div className="provider-capability-section-header">
                    <div className="provider-capability-badge provider-capability-badge-unclassified">
                      <AppIcon name="alert" size={14} />
                    </div>
                    <div>
                      <strong>待确认</strong>
                      <p>{uncategorizedCatalogModels.length} 个模型</p>
                    </div>
                  </div>

                  <div className="provider-capability-section-list">
                    {uncategorizedCatalogModels.map((modelPreset) => {
                      const added = isModelAddedToScenario(modelCatalogTargetScenario, modelPreset.id);

                      return (
                        <div className={added ? 'provider-model-item provider-model-item-active provider-model-item-compact' : 'provider-model-item provider-model-item-compact'} key={`unclassified-${modelPreset.id}`}>
                          <div className="provider-model-item-leading">
                            <span className="provider-model-item-icon" aria-hidden="true">
                              <AppIcon name={resolveModelIconName(modelPreset)} size={14} />
                            </span>
                            <div className="provider-model-item-copy">
                              <strong>{modelPreset.displayName}</strong>
                              {modelPreset.displayName.trim() !== modelPreset.id.trim() ? <span>{modelPreset.id}</span> : null}
                            </div>
                          </div>
                          <div className="provider-model-item-meta">
                            <span className="provider-setting-footnote">未命中本地注册表，已保留供手动确认。</span>
                            <button
                              className={added ? 'icon-button provider-row-action provider-row-action-danger' : 'icon-button provider-row-action'}
                              onClick={() => handleCatalogModelToggle(modelCatalogTargetScenario, modelPreset)}
                              type="button"
                            >
                              {added ? '删除' : '添加'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : null}
            </div>

            <div className="provider-scene-manual-row" style={{ marginTop: 12, padding: '0 16px 16px' }}>
              <input
                className="text-input"
                onChange={(event) => setManualModelIdDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    handleManualModelAdd();
                  }
                }}
                placeholder="手动输入模型 ID，例如 qwen-plus"
                value={manualModelIdDraft}
              />
              <button className="icon-button" onClick={handleManualModelAdd} type="button">
                <AppIcon name="spark" size={14} />
                手动添加
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {capabilityRegistryModalOpen ? (
        <div className="provider-modal-backdrop" onClick={() => setCapabilityRegistryModalOpen(false)} role="presentation">
          <div aria-label="能力注册表" aria-modal="true" className="provider-modal provider-advanced-modal content-card page-card compact-card" onClick={(event) => event.stopPropagation()} role="dialog">
            <div className="provider-panel-heading provider-panel-heading-compact">
              <div>
                <h3>能力注册表</h3>
                <p>本地注册表优先于模型名推断和上游能力字段，用来修正当前平台的模型能力标签。</p>
              </div>
              <div className="provider-model-toolbar">
                <button className="icon-button" onClick={() => handleCapabilityRegistryEntryAdd()} type="button">
                  <AppIcon name="cloud" size={14} />
                  添加条目
                </button>
                <button className="provider-header-icon" onClick={() => setCapabilityRegistryModalOpen(false)} title="关闭能力注册表" type="button">
                  <AppIcon name="close" size={13} />
                </button>
              </div>
            </div>

            <div className="provider-custom-header-list">
              {localModelCapabilityRegistry.length > 0 ? (
                localModelCapabilityRegistry.map((entry) => (
                  <div className="provider-capability-registry-item" key={entry.id}>
                    <input
                      className="text-input"
                      onChange={(event) => handleCapabilityRegistryEntryChange(entry.id, { modelId: event.target.value })}
                      placeholder="模型 ID，例如 qwen3-livetranslate-flash"
                      value={entry.modelId}
                    />
                    <div className="provider-scenario-switcher provider-capability-registry-pills">
                      {providerCapabilityOrder.map((capability) => (
                        <button
                          className={entry.capabilities.includes(capability) ? 'provider-scenario-pill provider-scenario-pill-active' : 'provider-scenario-pill'}
                          key={`${entry.id}-${capability}`}
                          onClick={() => handleCapabilityRegistryEntryToggle(entry.id, capability)}
                          type="button"
                        >
                          {formatProviderCapabilityLabel(capability)}
                        </button>
                      ))}
                    </div>
                    <button className="provider-header-icon provider-header-icon-danger" onClick={() => handleCapabilityRegistryEntryRemove(entry.id)} title="删除能力条目" type="button">
                      <AppIcon name="close" size={13} />
                    </button>
                  </div>
                ))
              ) : (
                <div className="provider-directory-empty provider-scene-empty">
                  <strong>还没有自定义能力条目</strong>
                  <p>当前先使用文档预置和模型名推断；如果有误判，可以在这里补充或修正。</p>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {advancedSettingsOpen ? (
        <div className="provider-modal-backdrop" onClick={() => setAdvancedSettingsOpen(false)} role="presentation">
          <div aria-label="高级设置" aria-modal="true" className="provider-modal provider-advanced-modal content-card page-card compact-card" onClick={(event) => event.stopPropagation()} role="dialog">
            <div className="provider-panel-heading provider-panel-heading-compact">
              <div>
                <h3>高级设置</h3>
              </div>
              <button className="provider-header-icon" onClick={() => setAdvancedSettingsOpen(false)} title="关闭高级设置" type="button">
                <AppIcon name="close" size={13} />
              </button>
            </div>

            <div className="field-grid provider-field-grid provider-modal-grid">
              <label className="field-stack">
                <span>显示名称</span>
                <input className="text-input" onChange={(event) => updateActiveProviderDraft({ displayName: event.target.value, status: 'draft' })} value={activeProvider.displayName} />
              </label>
              <label className="field-stack">
                <span>API 格式</span>
                <select className="select-input" onChange={(event) => handleProviderKindChange(event.target.value as ProviderKind)} value={activeProvider.kind}>
                  <option value="openai-compatible">OpenAI API 兼容接口</option>
                  <option value="dashscope">DashScope 接口</option>
                </select>
              </label>
              <label className="field-stack field-span-full">
                <span>接口地址</span>
                <input className="text-input" onChange={(event) => updateActiveProviderDraft({ baseUrl: event.target.value, status: 'draft' })} value={activeProvider.baseUrl} />
              </label>
              <label className="field-stack">
                <span>传输方式</span>
                <select className="select-input" onChange={(event) => updateActiveProviderDraft({ transport: event.target.value as ProviderTransport, status: 'draft' })} value={activeProvider.transport}>
                  {supportedTransportsForKind(activeProvider.kind).map((transport) => (
                    <option key={transport} value={transport}>
                      {formatTransportLabel(transport)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-stack">
                <span>超时阈值</span>
                <input className="text-input" min={1000} onChange={(event) => updateActiveProviderDraft({ timeoutMs: Number(event.target.value) || 0, status: 'draft' })} step={500} type="number" value={activeProvider.timeoutMs} />
              </label>
              <label className="field-stack">
                <span>认证方案</span>
                <select className="select-input" onChange={(event) => updateActiveProviderDraft({ authRef: { ...activeProvider.authRef, scheme: event.target.value as ProviderAuthScheme }, status: 'draft' })} value={activeProvider.authRef.scheme}>
                  <option value="bearer">Bearer</option>
                  <option value="api-key">API Key</option>
                  <option value="none">无认证</option>
                </select>
              </label>
              <label className="field-stack">
                <span>认证头字段</span>
                <input className="text-input" onChange={(event) => updateActiveProviderDraft({ authRef: { ...activeProvider.authRef, headerName: event.target.value }, status: 'draft' })} value={activeProvider.authRef.headerName} />
              </label>
              <label className="field-stack">
                <span>启用流式</span>
                <select className="select-input" onChange={(event) => updateActiveProviderDraft({ streamEnabled: event.target.value === 'true', status: 'draft' })} value={String(activeProvider.streamEnabled)}>
                  <option value="true">开启</option>
                  <option value="false">关闭</option>
                </select>
              </label>
              <label className="field-stack">
                <span>Temperature</span>
                <input className="text-input" max={2} min={0} onChange={(event) => updateActiveProviderDraft({ temperature: Number(event.target.value) || 0, status: 'draft' })} step={0.1} type="number" value={activeProvider.temperature} />
              </label>
              <label className="field-stack">
                <span>Max Output Tokens</span>
                <input className="text-input" min={1} onChange={(event) => updateActiveProviderDraft({ maxOutputTokens: Number(event.target.value) || 1, status: 'draft' })} step={1} type="number" value={activeProvider.maxOutputTokens} />
              </label>
              {typeof activeProvider.region === 'string' ? (
                <label className="field-stack">
                  <span>区域</span>
                  <input className="text-input" onChange={(event) => updateActiveProviderDraft({ region: event.target.value, status: 'draft' })} value={activeProvider.region} />
                </label>
              ) : null}
              <label className="field-stack field-span-full">
                <span>测试文本</span>
                <textarea className="text-area provider-compact-textarea" onChange={(event) => setSampleText(event.target.value)} rows={3} value={sampleText} />
              </label>
              <div className="field-stack field-span-full">
                <span>Response Modalities</span>
                <div className="provider-scenario-switcher">
                  {(['text', 'audio'] as ProviderResponseModality[]).map((modality) => (
                    <button
                      className={activeProvider.responseModalities.includes(modality) ? 'provider-scenario-pill provider-scenario-pill-active' : 'provider-scenario-pill'}
                      key={modality}
                      onClick={() => handleResponseModalityToggle(modality)}
                      type="button"
                    >
                      {modality === 'text' ? '文本' : '音频'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <section className="provider-setting-block provider-setting-block-compact">
              <div className="provider-setting-header provider-setting-header-compact">
                <div>
                  <strong>自定义请求头</strong>
                </div>
                <button className="icon-button" onClick={handleProviderCustomHeaderAdd} type="button">
                  <AppIcon name="cloud" size={14} />
                  添加请求头
                </button>
              </div>

              <div className="provider-custom-header-list">
                {activeProvider.customHeaders.length > 0 ? (
                  activeProvider.customHeaders.map((header) => (
                    <div className="provider-custom-header-item" key={header.id}>
                      <input className="text-input" onChange={(event) => handleProviderCustomHeaderChange(header.id, { name: event.target.value })} placeholder="Header 名称" value={header.name} />
                      <input className="text-input" onChange={(event) => handleProviderCustomHeaderChange(header.id, { value: event.target.value })} placeholder="Header 值" value={header.value} />
                      <select className="select-input" onChange={(event) => handleProviderCustomHeaderChange(header.id, { enabled: event.target.value === 'true' })} value={String(header.enabled)}>
                        <option value="true">启用</option>
                        <option value="false">停用</option>
                      </select>
                      <button className="provider-header-icon provider-header-icon-danger" onClick={() => handleProviderCustomHeaderRemove(header.id)} title="删除请求头" type="button">
                        <AppIcon name="close" size={13} />
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="provider-directory-empty provider-scene-empty">
                    <strong>还没有自定义请求头</strong>
                    <p>如果上游要求额外 Header，可以在这里继续补充。</p>
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      ) : null}

      {verificationModalOpen ? (
        <div className="provider-modal-backdrop" onClick={() => setVerificationModalOpen(false)} role="presentation">
          <div aria-label="验证详情" aria-modal="true" className="provider-modal provider-validation-modal content-card page-card compact-card" onClick={(event) => event.stopPropagation()} role="dialog">
            <div className="provider-panel-heading provider-panel-heading-compact">
              <div>
                <h3>验证详情</h3>
                <p>展示最近一次接入验证的探测与测试结果。</p>
              </div>
              <div className="provider-model-toolbar">
                <StatusBadge label={verificationSummaryLabel} tone={verificationSummaryTone} />
                <button className="provider-header-icon" onClick={() => setVerificationModalOpen(false)} title="关闭验证详情" type="button">
                  <AppIcon name="close" size={13} />
                </button>
              </div>
            </div>

            <div className="provider-validation-grid">
              <section className="provider-validation-section">
                <div className="provider-panel-heading provider-panel-heading-compact">
                  <div>
                    <h3>能力探测</h3>
                    <p>检查传输能力、延迟预算和返回形态。</p>
                  </div>
                </div>
                <ul className="bullet-list provider-insight-list provider-insight-list-compact">
                  <li>探测时间：{activeProbe.checkedAt}</li>
                  <li>探测延迟：{activeProbe.measuredLatencyMs} ms / 预算 {activeProbe.latencyBudgetMs} ms</li>
                  <li>请求传输：{activeProbe.transportRequested}</li>
                  <li>生效传输：{activeProbe.transportEffective}</li>
                  <li>实时返回：{activeProbe.streamSupported ? '支持' : '不支持'}</li>
                  <li>回退链路：{activeProbe.fallbackApplied ? '已触发' : '未触发'}</li>
                  <li>字幕策略：{formatSubtitlePriorityLabel(probeResult?.routingDecision.subtitlePriority ?? 'balanced')}</li>
                </ul>
                {activeProbe.guidance.length ? (
                  <div className="provider-chip-row provider-chip-row-compact provider-chip-row-tight">
                    {activeProbe.guidance.map((item) => (
                      <span className="provider-meta-chip provider-meta-chip-muted" key={item}>
                        {item}
                      </span>
                    ))}
                  </div>
                ) : null}
                {probeResult?.error ? (
                  <p className="provider-setting-footnote">
                    错误：{probeResult.error.code}，{probeResult.error.message}
                    {probeResult.error.suggestion ? `。${probeResult.error.suggestion}` : ''}
                  </p>
                ) : null}
              </section>

              {smokeResult ? (
                <section className="provider-validation-section">
                  <div className="provider-panel-heading provider-panel-heading-compact">
                    <div>
                      <h3>测试请求</h3>
                      <p>展示真实请求编号、耗时与输出内容。</p>
                    </div>
                  </div>
                  <ul className="bullet-list provider-insight-list provider-insight-list-compact">
                    <li>请求编号：{smokeResult.requestId}</li>
                    <li>执行状态：{formatSmokeStatusLabel(smokeResult.status)}</li>
                    <li>总耗时：{smokeResult.durationMs} ms</li>
                    <li>首包延迟：{smokeResult.firstEventLatencyMs ?? '无'} ms</li>
                    <li>流式返回：{smokeResult.streamObserved ? '已观察到' : '未观察到'}</li>
                    <li>字幕策略：{formatSubtitlePriorityLabel(smokeResult.routingDecision.subtitlePriority)}</li>
                  </ul>
                  <p className="provider-setting-footnote">
                    {smokeResult.error ? `错误：${smokeResult.error.code}，${smokeResult.error.message}` : `翻译结果：${smokeResult.transcript || '空'}`}
                  </p>
                  {smokeResult.eventLog.length > 0 ? (
                    <div className="result-log">
                      {smokeResult.eventLog.slice(0, 8).map((event) => (
                        <p key={`${event.eventType}-${event.summary}`}>{event.eventType} · {event.summary}</p>
                      ))}
                    </div>
                  ) : null}
                </section>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {customProviderDialogOpen ? (
        <div className="provider-modal-backdrop" onClick={closeCustomProviderDialog} role="presentation">
          <div aria-label="添加平台" aria-modal="true" className="provider-modal content-card page-card compact-card" onClick={(event) => event.stopPropagation()} role="dialog">
            <div className="provider-panel-heading provider-panel-heading-compact">
              <div>
                <h3>添加平台</h3>
                <p>创建自定义 Provider 模板，先记录接口地址和协议，模型与密钥稍后在接入页补充。</p>
              </div>
              <button className="provider-header-icon" onClick={closeCustomProviderDialog} title="关闭" type="button">
                <AppIcon name="close" size={13} />
              </button>
            </div>

            <div className="field-grid provider-field-grid provider-modal-grid">
              <label className="field-stack">
                <span>平台名称</span>
                <input className="text-input" onChange={(event) => setCustomProviderDraft((current) => ({ ...current, displayName: event.target.value }))} placeholder="例如 OpenRouter 自定义" value={customProviderDraft.displayName} />
              </label>
              <label className="field-stack">
                <span>平台类型</span>
                <select className="select-input" onChange={(event) => handleCustomProviderKindChange(event.target.value as ProviderKind)} value={customProviderDraft.kind}>
                  <option value="openai-compatible">OpenAI Compatible</option>
                  <option value="dashscope">DashScope</option>
                </select>
              </label>
              <label className="field-stack field-span-full">
                <span>接口地址</span>
                <input className="text-input" onChange={(event) => setCustomProviderDraft((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://example.com/v1" value={customProviderDraft.baseUrl} />
              </label>
              <label className="field-stack">
                <span>传输方式</span>
                <select className="select-input" onChange={(event) => setCustomProviderDraft((current) => ({ ...current, transport: event.target.value as ProviderTransport }))} value={customProviderDraft.transport}>
                  {(customProviderDraft.kind === 'dashscope' ? ['http', 'websocket'] : ['http', 'streaming-http']).map((transport) => (
                    <option key={transport} value={transport}>
                      {formatTransportLabel(transport)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-stack">
                <span>认证头字段</span>
                <input className="text-input" onChange={(event) => setCustomProviderDraft((current) => ({ ...current, authHeaderName: event.target.value }))} placeholder="Authorization" value={customProviderDraft.authHeaderName} />
              </label>
              <label className="field-stack">
                <span>认证方案</span>
                <select className="select-input" onChange={(event) => setCustomProviderDraft((current) => ({ ...current, authScheme: event.target.value as ProviderAuthScheme }))} value={customProviderDraft.authScheme}>
                  <option value="bearer">Bearer</option>
                  <option value="api-key">API Key</option>
                  <option value="none">无认证</option>
                </select>
              </label>
              {customProviderDraft.kind === 'dashscope' ? (
                <label className="field-stack">
                  <span>区域</span>
                  <input className="text-input" onChange={(event) => setCustomProviderDraft((current) => ({ ...current, region: event.target.value }))} placeholder="cn-beijing" value={customProviderDraft.region} />
                </label>
              ) : null}
              <label className="field-stack">
                <span>超时阈值</span>
                <input className="text-input" min={1000} onChange={(event) => setCustomProviderDraft((current) => ({ ...current, timeoutMs: Number(event.target.value) || 0 }))} step={500} type="number" value={customProviderDraft.timeoutMs} />
              </label>
            </div>

            {customProviderError ? <div className="provider-inline-alert provider-inline-alert-warning">{customProviderError}</div> : null}

            <div className="provider-modal-actions provider-modal-actions-compact">
              <button className="icon-button" onClick={closeCustomProviderDialog} type="button">
                <AppIcon name="close" size={13} />
                取消
              </button>
              <button className="action-button" onClick={handleCustomProviderSave} type="button">
                <AppIcon name="cloud" size={14} />
                创建平台
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default ProvidersPage;
