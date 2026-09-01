import type { TFunction } from 'i18next';
import type { Dispatch, SetStateAction } from 'react';
import type {
  ProviderCustomHeaderDraft,
  AudioRouteMode,
  ProviderDraft,
  ProviderModelCapabilityRegistryEntry,
  ProviderResponseModality,
  ProviderScenario,
} from '../../schema/config';
import type { ProviderCapability, ProviderInteractionCapability } from '../../schema/provider-contract';
import type { ProviderModelRuntime } from '../../schema/provider-runtime';
import type { ProviderTemplate } from '../../schema/provider-template';
import { useAppStore } from '../../stores/app-store';
import {
  capabilityForScenario,
  createProviderModelCapabilityRegistryEntry,
  normalizeProviderCapabilityList,
  normalizeProviderInteractionCapabilityList,
  normalizeProviderModels,
  resolveInteractionCapabilities,
  resolveProviderModelCapabilities,
} from '../../utils/provider-model-capabilities';
import {
  providersPageHelpers,
  type ModelCatalogScenarioFilter,
  type ModelCatalogState,
  type PendingModelRegistration,
} from './providersPageHelpers';

type Params = {
  t: TFunction;
  activeProvider: ProviderDraft;
  activeTemplate: ProviderTemplate;
  sceneAssignments: ProviderDraft['sceneModelAssignments'];
  localModelCapabilityRegistry: ProviderModelCapabilityRegistryEntry[];
  modelLookup: Map<string, ProviderModelRuntime>;
  modelCatalogSignature: string;
  modelCatalogTargetScenario: ProviderScenario;
  manualModelIdDraft: string;
  pendingModelRegistration: PendingModelRegistration | null;
  draggingSceneModel: { scenario: ProviderScenario; modelId: string } | null;
  routeMode: AudioRouteMode;
  providerRuntimeBlocked: boolean;
  providerRuntimeStatusMessage: string | null;
  setModelCatalog: Dispatch<SetStateAction<ModelCatalogState>>;
  setModelCatalogTargetScenario: Dispatch<SetStateAction<ProviderScenario>>;
  setSelectedCatalogScenario: Dispatch<SetStateAction<ModelCatalogScenarioFilter>>;
  setModelCatalogModalOpen: Dispatch<SetStateAction<boolean>>;
  setManualModelIdDraft: Dispatch<SetStateAction<string>>;
  setPendingModelRegistration: Dispatch<SetStateAction<PendingModelRegistration | null>>;
  refreshModelCatalog: () => Promise<void>;
};

export function useProviderModelEditorController(params: Params) {
  const updateActiveProviderDraft = useAppStore((state) => state.updateActiveProviderDraft);
  const updateProviders = useAppStore((state) => state.updateProviders);

  const syncProviderInArray = (nextProvider: ProviderDraft) => {
    const providers = [...useAppStore.getState().configDraft.providers];
    const index = providers.findIndex((provider) => provider.templateId === nextProvider.templateId);
    if (index >= 0) {
      providers[index] = { ...nextProvider };
      updateProviders(providers);
    }
  };

  const updateSceneModelAssignments = (
    nextAssignments: ProviderDraft['sceneModelAssignments'],
    nextModel?: string,
  ) => {
    const assignments = providersPageHelpers.ensureSceneAssignments(nextAssignments);
    updateActiveProviderDraft({ sceneModelAssignments: assignments, ...(nextModel ? { model: nextModel } : {}), status: 'draft' });
    syncProviderInArray({
      ...providersPageHelpers.getActiveProviderFromState(),
      sceneModelAssignments: assignments,
      ...(nextModel ? { model: nextModel } : {}),
    } as ProviderDraft);
  };

  const hasCapabilityRegistryEntry = (modelId: string) => params.localModelCapabilityRegistry
    .some((entry) => entry.modelId.trim().toLowerCase() === modelId.trim().toLowerCase());

  const isModelAddedToScenario = (scenario: ModelCatalogScenarioFilter, modelId: string) => scenario === 'all'
    ? params.sceneAssignments.some((item) => item.modelIds.includes(modelId))
    : params.sceneAssignments.find((item) => item.scenario === scenario)?.modelIds.includes(modelId) ?? false;

  const handleModelCatalogOpen = (scenario?: ProviderScenario) => {
    const target = scenario ?? params.routeMode;
    params.setModelCatalogTargetScenario(target);
    params.setSelectedCatalogScenario(scenario ?? 'all');
    params.setModelCatalogModalOpen(true);
    params.setModelCatalog(providersPageHelpers.createEmptyModelCatalog(params.modelCatalogSignature, 'loading'));
    if (!params.providerRuntimeBlocked) {
      void params.refreshModelCatalog();
    } else {
      params.setModelCatalog(providersPageHelpers.createEmptyModelCatalog(
        params.modelCatalogSignature,
        'error',
        params.providerRuntimeStatusMessage ?? params.t('providers.messages.storageBlockedAction', {
          action: params.t('providers.actions.fetchModelList'),
        }),
      ));
    }
  };

  const handleSceneModelAdd = (scenario: ProviderScenario, model: ProviderModelRuntime) => {
    updateSceneModelAssignments(
      providersPageHelpers.addSceneModel(params.sceneAssignments, scenario, model.id),
      scenario === params.routeMode ? model.id : undefined,
    );
  };

  const openPendingModelRegistration = (scenario: ProviderScenario, model: ProviderModelRuntime) => {
    const capabilities = resolveProviderModelCapabilities(model, params.localModelCapabilityRegistry);
    const realtimeAudioMode = 'server_vad' as const;
    params.setPendingModelRegistration({
      scenario,
      model,
      capabilities: capabilities.length ? capabilities : [capabilityForScenario(scenario)],
      realtimeAudioMode,
      interactionCapabilities: ['auto_vad'],
    });
  };

  const applyLocalModelCapabilityRegistry = (entries: ProviderModelCapabilityRegistryEntry[]) => {
    const normalized = entries.map((entry) => ({
      ...entry,
      modelId: entry.modelId.trim(),
      capabilities: normalizeProviderCapabilityList(entry.capabilities),
      realtimeAudioMode: entry.realtimeAudioMode ?? 'server_vad',
      interactionCapabilities: normalizeProviderInteractionCapabilityList(
        entry.interactionCapabilities ?? [],
      ),
    }));
    updateActiveProviderDraft({ localModelCapabilityRegistry: normalized, status: 'draft' });
    params.setModelCatalog((current) => ({ ...current, models: normalizeProviderModels(current.models, normalized) }));
  };

  const handleManualModelAdd = () => {
    const modelId = params.manualModelIdDraft.trim();
    if (!modelId) return;
    const model = params.modelLookup.get(modelId)
      ?? providersPageHelpers.createDerivedRuntimeModel(modelId, params.localModelCapabilityRegistry, 'manual');
    if (!hasCapabilityRegistryEntry(modelId)) {
      openPendingModelRegistration(params.modelCatalogTargetScenario, model);
      return;
    }
    handleSceneModelAdd(params.modelCatalogTargetScenario, model);
    params.setManualModelIdDraft('');
  };

  const handlePendingRegistrationCapabilityToggle = (capability: ProviderCapability) => {
    params.setPendingModelRegistration((current) => current ? {
      ...current,
      capabilities: normalizeProviderCapabilityList(current.capabilities.includes(capability)
        ? current.capabilities.filter((item) => item !== capability)
        : [...current.capabilities, capability]),
    } : current);
  };

  const handlePendingRegistrationInteractionToggle = (capability: ProviderInteractionCapability) => {
    params.setPendingModelRegistration((current) => current ? {
      ...current,
      interactionCapabilities: normalizeProviderInteractionCapabilityList(current.interactionCapabilities.includes(capability)
        ? current.interactionCapabilities.filter((item) => item !== capability)
        : [...current.interactionCapabilities, capability]),
    } : current);
  };

  const handlePendingRegistrationConfirm = () => {
    const pending = params.pendingModelRegistration;
    if (!pending || pending.capabilities.length === 0) return;
    applyLocalModelCapabilityRegistry([
      createProviderModelCapabilityRegistryEntry(
        pending.model.id,
        pending.capabilities,
        pending.realtimeAudioMode,
        pending.interactionCapabilities,
      ),
      ...params.localModelCapabilityRegistry.filter((entry) => entry.modelId.trim().toLowerCase() !== pending.model.id.trim().toLowerCase()),
    ]);
    updateSceneModelAssignments(
      providersPageHelpers.addSceneModel(params.sceneAssignments, pending.scenario, pending.model.id),
      pending.scenario === params.routeMode ? pending.model.id : undefined,
    );
    params.setManualModelIdDraft('');
    params.setPendingModelRegistration(null);
  };

  const handleSceneModelRemove = (scenario: ProviderScenario, modelId: string) => {
    const result = providersPageHelpers.removeSceneModel(
      params.sceneAssignments,
      scenario,
      modelId,
      params.routeMode,
      params.activeProvider.model,
      params.activeTemplate.defaultDraft.model,
    );
    updateSceneModelAssignments(result.assignments, result.nextModel);
  };

  const handleCatalogModelToggle = (scenario: ProviderScenario, model: ProviderModelRuntime) => {
    if (isModelAddedToScenario(scenario, model.id)) return handleSceneModelRemove(scenario, model.id);
    if (!hasCapabilityRegistryEntry(model.id) && model.capabilities.length === 0) return openPendingModelRegistration(scenario, model);
    handleSceneModelAdd(scenario, model);
  };

  const handleProviderCustomHeaderChange = (headerId: string, patch: Partial<ProviderCustomHeaderDraft>) => {
    updateActiveProviderDraft({
      customHeaders: params.activeProvider.customHeaders.map((item) => item.id === headerId ? { ...item, ...patch } : item),
      status: 'draft',
    });
  };
  const handleProviderCustomHeaderAdd = () => updateActiveProviderDraft({
    customHeaders: [...params.activeProvider.customHeaders, providersPageHelpers.createCustomHeaderDraft()],
    status: 'draft',
  });
  const handleProviderCustomHeaderRemove = (headerId: string) => updateActiveProviderDraft({
    customHeaders: params.activeProvider.customHeaders.filter((item) => item.id !== headerId),
    status: 'draft',
  });

  const handleCapabilityRegistryEntryAdd = (modelId = '') => applyLocalModelCapabilityRegistry([
    createProviderModelCapabilityRegistryEntry(modelId),
    ...params.localModelCapabilityRegistry,
  ]);
  const handleCapabilityRegistryEntryChange = (entryId: string, patch: Partial<ProviderModelCapabilityRegistryEntry>) => {
    applyLocalModelCapabilityRegistry(params.localModelCapabilityRegistry.map((entry) => entry.id === entryId ? {
      ...entry,
      ...patch,
      capabilities: patch.capabilities ? normalizeProviderCapabilityList(patch.capabilities) : entry.capabilities,
      realtimeAudioMode: patch.realtimeAudioMode ?? entry.realtimeAudioMode,
      interactionCapabilities: patch.interactionCapabilities
        ? normalizeProviderInteractionCapabilityList(patch.interactionCapabilities)
        : entry.interactionCapabilities,
    } : entry));
  };
  const handleCapabilityRegistryEntryToggle = (entryId: string, capability: ProviderCapability) => {
    const entry = params.localModelCapabilityRegistry.find((item) => item.id === entryId);
    if (!entry) return;
    handleCapabilityRegistryEntryChange(entryId, { capabilities: entry.capabilities.includes(capability)
      ? entry.capabilities.filter((item) => item !== capability)
      : [...entry.capabilities, capability] });
  };
  const handleCapabilityRegistryInteractionToggle = (entryId: string, capability: ProviderInteractionCapability) => {
    const entry = params.localModelCapabilityRegistry.find((item) => item.id === entryId);
    if (!entry) return;
    const current = resolveInteractionCapabilities(entry.modelId, [entry]);
    handleCapabilityRegistryEntryChange(entryId, { interactionCapabilities: current.includes(capability)
      ? current.filter((item) => item !== capability)
      : [...current, capability] });
  };
  const handleCapabilityRegistryEntryRemove = (entryId: string) => applyLocalModelCapabilityRegistry(
    params.localModelCapabilityRegistry.filter((entry) => entry.id !== entryId),
  );
  const handleResponseModalityToggle = (modality: ProviderResponseModality) => updateActiveProviderDraft({
    responseModalities: providersPageHelpers.toggleResponseModalities(params.activeProvider.responseModalities, modality),
    status: 'draft',
  });
  const handleSceneModelReorder = (scenario: ProviderScenario, targetModelId: string) => {
    const next = providersPageHelpers.reorderSceneModels(params.sceneAssignments, params.draggingSceneModel, scenario, targetModelId);
    if (next !== params.sceneAssignments) updateSceneModelAssignments(next);
  };

  return {
    isModelAddedToScenario,
    handleModelCatalogOpen,
    handleManualModelAdd,
    handlePendingRegistrationCapabilityToggle,
    handlePendingRegistrationInteractionToggle,
    handlePendingRegistrationConfirm,
    handleCatalogModelToggle,
    handleSceneModelRemove,
    handleProviderCustomHeaderChange,
    handleProviderCustomHeaderAdd,
    handleProviderCustomHeaderRemove,
    handleCapabilityRegistryEntryAdd,
    handleCapabilityRegistryEntryChange,
    handleCapabilityRegistryEntryToggle,
    handleCapabilityRegistryInteractionToggle,
    handleCapabilityRegistryEntryRemove,
    handleResponseModalityToggle,
    handleSceneModelReorder,
  };
}
