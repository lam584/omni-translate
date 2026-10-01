import { ensureCandidateModelGroups } from '../../utils/candidate-model-groups';
import { modelRegistryEditorPatch, resetModelCapabilityOverride } from '../../utils/provider-model-capabilities-registry';
import type { TFunction } from 'i18next';
import type { Dispatch, SetStateAction } from 'react';
import type {
  ProviderCustomHeaderDraft,
  CandidateModelGroupId,
  ProviderDraft,
  ProviderModelCapabilityRegistryEntry,
  ProviderResponseModality,
  ProviderSceneModelAssignment,
} from '../../schema/config';
import type { ProviderCapability, ProviderInteractionCapability } from '../../schema/provider-contract';
import type { ProviderModelRuntime } from '../../schema/provider-runtime';
import type { ProviderTemplate } from '../../schema/provider-template';
import { useAppStore } from '../../stores/app-store';
import {
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
  sceneAssignments?: ProviderSceneModelAssignment[];
  localModelCapabilityRegistry: ProviderModelCapabilityRegistryEntry[];
  modelLookup: Map<string, ProviderModelRuntime>;
  modelCatalogSignature: string;
  modelCatalogTargetScenario: CandidateModelGroupId;
  manualModelIdDraft: string;
  pendingModelRegistration: PendingModelRegistration | null;
  draggingSceneModel?: { scenario: string; modelId: string } | null;
  routeMode?: string;
  providerRuntimeBlocked: boolean;
  providerRuntimeStatusMessage: string | null;
  setModelCatalog: Dispatch<SetStateAction<ModelCatalogState>>;
  setModelCatalogTargetScenario: Dispatch<SetStateAction<CandidateModelGroupId>>;
  setSelectedCatalogScenario: Dispatch<SetStateAction<ModelCatalogScenarioFilter>>;
  setModelCatalogModalOpen: Dispatch<SetStateAction<boolean>>;
  setManualModelIdDraft: Dispatch<SetStateAction<string>>;
  setPendingModelRegistration: Dispatch<SetStateAction<PendingModelRegistration | null>>;
  refreshModelCatalog: () => Promise<void>;
};

export function useProviderModelEditorController(params: Params) {
  const updateActiveProviderDraft = useAppStore((state) => state.updateActiveProviderDraft);
  const updateCandidateGroups = (group: CandidateModelGroupId, modelIds: string[]) => {
    const groups = ensureCandidateModelGroups(params.activeProvider.candidateModelGroups);
    updateActiveProviderDraft({
      candidateModelGroups: groups.map((entry) => entry.group === group ? { group, modelIds } : entry),
      status: 'draft',
    });
  };

  const hasCapabilityRegistryEntry = (modelId: string) => params.localModelCapabilityRegistry
    .some((entry) => entry.modelId === modelId);

  const isModelAddedToScenario = (group: ModelCatalogScenarioFilter, modelId: string) => group === 'all'
    ? (params.activeProvider.candidateModelGroups ?? []).some((entry) => entry.modelIds.includes(modelId))
    : (params.activeProvider.candidateModelGroups ?? []).some((entry) => entry.group === group && entry.modelIds.includes(modelId));

  const handleModelCatalogOpen = (group?: CandidateModelGroupId) => {
    params.setModelCatalogTargetScenario(group ?? 'realtime-multimodal');
    params.setSelectedCatalogScenario(group ?? 'all');
    params.setModelCatalogModalOpen(true);
    params.setModelCatalog(providersPageHelpers.createEmptyModelCatalog(params.modelCatalogSignature, 'loading'));
    if (!params.providerRuntimeBlocked) {
      void params.refreshModelCatalog();
    } else {
      params.setModelCatalog(providersPageHelpers.createEmptyModelCatalog(
        params.modelCatalogSignature, 'error',
        params.providerRuntimeStatusMessage ?? params.t('providers.messages.storageBlockedAction', {
          action: params.t('providers.actions.fetchModelList'),
        }),
      ));
    }
  };

  const handleSceneModelAdd = (group: CandidateModelGroupId, model: ProviderModelRuntime) => {
    const current = ensureCandidateModelGroups(params.activeProvider.candidateModelGroups).find((entry) => entry.group === group)!.modelIds;
    if (!current.includes(model.id)) updateCandidateGroups(group, [...current, model.id]);
  };

  const openPendingModelRegistration = (group: CandidateModelGroupId, model: ProviderModelRuntime) => {
    const capabilities = resolveProviderModelCapabilities(model, params.localModelCapabilityRegistry);
    const fallback: Record<CandidateModelGroupId, ProviderCapability> = {
      'text-processing': 'text-generation',
      'audio-understanding': 'speech-to-text',
      'audio-generation': 'text-to-speech',
      'realtime-multimodal': 'speech-to-speech',
    };
    params.setPendingModelRegistration({ group, model,
      capabilities: capabilities.length ? capabilities : [fallback[group]],
      realtimeAudioMode: 'server_vad', interactionCapabilities: ['auto_vad'],
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
    updateActiveProviderDraft({ ...modelRegistryEditorPatch(params.activeProvider, normalized, params.localModelCapabilityRegistry), status: 'draft' });
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
      ...params.localModelCapabilityRegistry.filter((entry) => entry.modelId !== pending.model.id),
    ]);
    handleSceneModelAdd(pending.group, pending.model);
    params.setManualModelIdDraft('');
    params.setPendingModelRegistration(null);
  };

  const handleSceneModelRemove = (group: CandidateModelGroupId, modelId: string) => {
    const current = ensureCandidateModelGroups(params.activeProvider.candidateModelGroups).find((entry) => entry.group === group)!.modelIds;
    updateCandidateGroups(group, current.filter((id) => id !== modelId));
  };

  const handleCatalogModelToggle = (group: CandidateModelGroupId, model: ProviderModelRuntime) => {
    if (isModelAddedToScenario(group, model.id)) return handleSceneModelRemove(group, model.id);
    if (!hasCapabilityRegistryEntry(model.id) && model.capabilities.length === 0) return openPendingModelRegistration(group, model);
    handleSceneModelAdd(group, model);
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
  const handleCapabilityRegistryEntryRemove = (entryId: string) => {
    const entry = params.localModelCapabilityRegistry.find((candidate) => candidate.id === entryId);
    if (entry) updateActiveProviderDraft(resetModelCapabilityOverride(params.activeProvider, entry.modelId));
  };
  const handleResponseModalityToggle = (modality: ProviderResponseModality) => updateActiveProviderDraft({
    responseModalities: providersPageHelpers.toggleResponseModalities(params.activeProvider.responseModalities, modality),
    status: 'draft',
  });
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
  };
}
