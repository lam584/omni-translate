import { useEffect, type Dispatch, type MouseEvent, type MutableRefObject, type SetStateAction } from 'react';
import type { ProviderDraft, ProviderSceneModelAssignment } from '../../schema/config';
import type { ProviderTemplate } from '../../schema/provider-template';
import { useAppStore } from '../../stores/app-store';
import { buildDefaultSceneModelAssignments, buildProviderDraftPatchFromTemplate } from '../../utils/provider-draft';
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
  sceneAssignments: ProviderSceneModelAssignment[];
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
  sceneAssignments,
  setCustomTemplates,
  onTemplateChanged,
}: Params) {
  const updateActiveProviderDraft = useAppStore((state) => state.updateActiveProviderDraft);
  const updateActiveProviderTemplateId = useAppStore((state) => state.updateActiveProviderTemplateId);
  const updateDiagnosticsDraft = useAppStore((state) => state.updateDiagnosticsDraft);
  const updateProviders = useAppStore((state) => state.updateProviders);

  useEffect(() => {
    if (activeTemplate.source !== 'custom' || !activeCustomTemplateDraft
      || JSON.stringify(activeCustomTemplateDraft) === JSON.stringify(providerDraftForCustomTemplate)) return;
    const nextTemplate = updateCustomProviderTemplate(activeTemplate, providerDraftForCustomTemplate);
    const nextTemplates = customTemplates.map((template) => template.id === activeTemplate.id ? nextTemplate : template);
    writeCustomProviderTemplates(nextTemplates);
    queueMicrotask(() => setCustomTemplates(nextTemplates));
  }, [activeCustomTemplateDraft, activeTemplate, customTemplates, providerDraftForCustomTemplate, setCustomTemplates]);

  const applyTemplate = (template: ProviderTemplate) => {
    const currentTemplateId = useAppStore.getState().configDraft.activeProviderTemplateId;
    if (currentTemplateId === template.id) return;
    if (currentTemplateId) providersPageHelpers.globalTemplateSceneAssignments.set(currentTemplateId, sceneAssignments);
    const providers = [...useAppStore.getState().configDraft.providers];
    const oldIndex = providers.findIndex((provider) => provider.templateId === currentTemplateId);
    if (oldIndex >= 0) providers[oldIndex] = { ...activeProvider, sceneModelAssignments: sceneAssignments };
    const existingIndex = providers.findIndex((provider) => provider.templateId === template.id);
    const savedAssignments = providersPageHelpers.globalTemplateSceneAssignments.get(template.id);
    if (existingIndex < 0) {
      providers.push({
        ...buildProviderDraftPatchFromTemplate(activeProvider, template),
        sceneModelAssignments: savedAssignments ? providersPageHelpers.ensureSceneAssignments(savedAssignments)
          : buildDefaultSceneModelAssignments(template),
        model: template.defaultDraft.model,
        status: 'draft',
      } as ProviderDraft);
    }
    updateProviders(providers);
    updateActiveProviderTemplateId(template.id);
    if (savedAssignments) {
      updateActiveProviderDraft({ sceneModelAssignments: providersPageHelpers.ensureSceneAssignments(savedAssignments), status: 'draft' });
    } else if (existingIndex >= 0) {
      const existing = providers[existingIndex];
      updateActiveProviderDraft(existing.sceneModelAssignments?.length
        ? { sceneModelAssignments: providersPageHelpers.ensureSceneAssignments(existing.sceneModelAssignments), status: 'draft' }
        : { sceneModelAssignments: buildDefaultSceneModelAssignments(template), model: template.defaultDraft.model, status: 'draft' });
    }
    updateDiagnosticsDraft({ providerStatus: 'draft' });
    onTemplateChanged(template);
  };

  const persistCustomTemplates = (templates: ProviderTemplate[]) => {
    writeCustomProviderTemplates(templates);
    setCustomTemplates(templates);
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
    setTemplateCatalogPreferences(nextPreferences);
    persistProviderTemplateCatalogEntries(nextEntries);
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
