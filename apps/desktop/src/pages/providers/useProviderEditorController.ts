import { useCallback, useEffect, type Dispatch, type MouseEvent, type MutableRefObject, type SetStateAction } from 'react';
import type { ProviderDraft } from '../../schema/config';
import type { ProviderTemplate } from '../../schema/provider-template';
import { useAppStore } from '../../stores/app-store';
import { buildProviderDraftPatchFromTemplate } from '../../utils/provider-draft';
import { migrateProviderCandidateModelGroups } from '../../utils/candidate-model-groups';
import { updateCustomProviderTemplate, writeCustomProviderTemplates, type CustomProviderTemplateDraft } from '../../utils/custom-provider-templates';
import {
  persistProviderTemplateCatalogEntries,
  type ProviderTemplateCatalogEntry,
  type ProviderTemplateCatalogPreference,
} from '../../utils/provider-template-catalog';
import { providersPageHelpers } from './providersPageHelpers';

type Params = {
  entries: ProviderTemplateCatalogEntry[];
  draggingTemplateId: string | null;
  setDraggingTemplateId: Dispatch<SetStateAction<string | null>>;
  setTemplateCatalogPreferences: Dispatch<SetStateAction<ProviderTemplateCatalogPreference[]>>;
  draggingTemplateIdRef: MutableRefObject<string | null>;
  templateMouseDragMovedRef: MutableRefObject<boolean>;
  templateMouseHoverTargetRef: MutableRefObject<string | null>;
  activeProvider: ProviderDraft;
  activeTemplate: ProviderTemplate;
  activeCustomTemplateDraft: CustomProviderTemplateDraft | null;
  customTemplates: ProviderTemplate[];
  providerDraftForCustomTemplate: CustomProviderTemplateDraft;
  setCustomTemplates: Dispatch<SetStateAction<ProviderTemplate[]>>;
  onTemplateChanged: (template: ProviderTemplate) => void;
};

export function useProviderEditorController({
  entries,
  draggingTemplateId,
  setDraggingTemplateId,
  setTemplateCatalogPreferences,
  draggingTemplateIdRef,
  templateMouseDragMovedRef,
  templateMouseHoverTargetRef,
  activeProvider,
  activeTemplate,
  activeCustomTemplateDraft,
  customTemplates,
  providerDraftForCustomTemplate,
  setCustomTemplates,
  onTemplateChanged,
}: Params) {
  const updateActiveProviderTemplateId = useAppStore((state) => state.updateActiveProviderTemplateId);
  const updateDiagnosticsDraft = useAppStore((state) => state.updateDiagnosticsDraft);
  const updateProviders = useAppStore((state) => state.updateProviders);
  const pushRuntimeNotification = useAppStore((state) => state.pushRuntimeNotification);

  const reportCustomTemplateWriteFailure = useCallback((detail: string) => {
    pushRuntimeNotification({
      id: `custom-provider-write-failed-${Date.now()}`,
      level: 'error',
      source: 'desktop-runtime',
      message: `自定义提供商未保存：${detail}。请检查浏览器存储权限后重试。`,
      emittedAt: new Date().toISOString(),
    });
  }, [pushRuntimeNotification]);

  useEffect(() => {
    if (activeTemplate.source !== 'custom' || !activeCustomTemplateDraft) return;
    const draftChanged = JSON.stringify(activeCustomTemplateDraft) !== JSON.stringify(providerDraftForCustomTemplate);
    const bindingOwnerMatches = activeProvider.templateId === activeTemplate.id;
    const bindingsChanged = bindingOwnerMatches && JSON.stringify(activeTemplate.defaultDraft.modelProtocolBindings ?? [])
      !== JSON.stringify(activeProvider.modelProtocolBindings ?? []);
    if (!draftChanged && !bindingsChanged) return;
    const nextTemplate = updateCustomProviderTemplate(activeTemplate, providerDraftForCustomTemplate);
    if (bindingOwnerMatches) nextTemplate.defaultDraft.modelProtocolBindings = activeProvider.modelProtocolBindings ?? [];
    const nextTemplates = customTemplates.map((template) => template.id === activeTemplate.id ? nextTemplate : template);
    const result = writeCustomProviderTemplates(nextTemplates);
    if (result.ok) queueMicrotask(() => setCustomTemplates(nextTemplates));
    else reportCustomTemplateWriteFailure(result.error);
  }, [activeCustomTemplateDraft, activeTemplate, activeProvider.modelProtocolBindings, activeProvider.templateId, customTemplates, providerDraftForCustomTemplate, reportCustomTemplateWriteFailure, setCustomTemplates]);

  const applyTemplate = (template: ProviderTemplate) => {
    const currentTemplateId = useAppStore.getState().configDraft.activeProviderTemplateId;
    if (currentTemplateId === template.id) return;
    const providers = [...useAppStore.getState().configDraft.providers];
    const oldIndex = providers.findIndex((provider) => provider.templateId === currentTemplateId);
    if (oldIndex >= 0) providers[oldIndex] = migrateProviderCandidateModelGroups(activeProvider);
    const existingIndex = providers.findIndex((provider) => provider.templateId === template.id);
    if (existingIndex < 0) {
      providers.push({
        ...buildProviderDraftPatchFromTemplate(activeProvider, template),
        model: template.defaultDraft.model,
        status: 'draft',
      } as ProviderDraft);
    } else {
      // Switching providers must not restore discarded legacy scene selections.
      providers[existingIndex] = migrateProviderCandidateModelGroups(providers[existingIndex]);
    }
    updateProviders(providers);
    updateActiveProviderTemplateId(template.id);
    updateDiagnosticsDraft({ providerStatus: 'draft' });
    onTemplateChanged(template);
  };

  const persistCustomTemplates = (templates: ProviderTemplate[]) => {
    const result = writeCustomProviderTemplates(templates);
    if (!result.ok) {
      reportCustomTemplateWriteFailure(result.error);
      return false;
    }
    setCustomTemplates(templates);
    return true;
  };

  const removeProviderDraft = (templateId: string) => {
    updateProviders(useAppStore.getState().configDraft.providers.filter((provider) => provider.templateId !== templateId));
  };
  const updateTemplateCatalogEntries = (nextEntries: ProviderTemplateCatalogEntry[]) => {
    const nextPreferences = nextEntries.map((entry, index) => ({
      templateId: entry.template.id,
      enabled: entry.enabled,
      hidden: entry.hidden,
      order: index,
    }));
    try {
      persistProviderTemplateCatalogEntries(nextEntries);
      setTemplateCatalogPreferences(nextPreferences);
    } catch (error) {
      pushRuntimeNotification({
        id: `provider-catalog-persist-failed-${Date.now()}`,
        level: 'error',
        source: 'desktop-runtime',
        message: `平台启用状态或排序未保存，界面已回滚。请检查本地存储权限后重试。技术详情：${error instanceof Error ? error.message : String(error)}`,
        emittedAt: new Date().toISOString(),
      });
    }
  };

  const handleTemplateEnabledToggle = (templateId: string) => {
    updateTemplateCatalogEntries(entries.map((entry) => (
      entry.template.id === templateId ? { ...entry, enabled: !entry.enabled } : entry
    )));
  };

  const handleTemplateReorder = (sourceTemplateId: string, targetTemplateId: string) => {
    const nextEntries = providersPageHelpers.reorderTemplateEntries(entries, sourceTemplateId, targetTemplateId);
    if (nextEntries !== entries) updateTemplateCatalogEntries(nextEntries);
  };

  const handleTemplateMouseDown = (event: MouseEvent<HTMLButtonElement>, templateId: string) => {
    if (event.button !== 0) return;
    templateMouseDragMovedRef.current = false;
    templateMouseHoverTargetRef.current = null;
    draggingTemplateIdRef.current = templateId;
    setDraggingTemplateId(templateId);
  };

  const handleTemplateMouseOver = (event: MouseEvent<HTMLButtonElement>, targetTemplateId: string) => {
    const sourceTemplateId = draggingTemplateIdRef.current;
    if (
      (event.buttons & 1) !== 1
      || !sourceTemplateId
      || sourceTemplateId === targetTemplateId
      || templateMouseHoverTargetRef.current === targetTemplateId
    ) return;

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
    if (!draggingTemplateId) return undefined;
    const handleWindowMouseUp = () => {
      draggingTemplateIdRef.current = null;
      templateMouseHoverTargetRef.current = null;
      setDraggingTemplateId(null);
    };
    window.addEventListener('mouseup', handleWindowMouseUp);
    return () => window.removeEventListener('mouseup', handleWindowMouseUp);
  }, [draggingTemplateId, draggingTemplateIdRef, setDraggingTemplateId, templateMouseHoverTargetRef]);

  return {
    updateTemplateCatalogEntries,
    handleTemplateEnabledToggle,
    handleTemplateMouseDown,
    handleTemplateMouseOver,
    handleTemplateMouseUp,
    applyTemplate,
    persistCustomTemplates,
    removeProviderDraft,
  };
}
