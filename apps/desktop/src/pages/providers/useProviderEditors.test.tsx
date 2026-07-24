import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfigDraftMock } from '../../mocks/app-config';
import { providerTemplates } from '../../mocks/provider-templates';
import type { ProviderModelRuntime } from '../../schema/provider-runtime';
import { useAppStore } from '../../stores/app-store';
import { customProviderTemplateToDraft } from '../../utils/custom-provider-templates';
import type { ProviderTemplateCatalogEntry } from '../../utils/provider-template-catalog';
import { providersPageHelpers } from './providersPageHelpers';
import { useProviderEditorController } from './useProviderEditorController';
import { useProviderModelEditorController } from './useProviderModelEditorController';

describe('provider editor controllers', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    useAppStore.setState((state) => ({ ...state, configDraft: structuredClone(appConfigDraftMock) }));
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it('updates custom templates and covers every template-application branch', async () => {
    const activeProvider = structuredClone(appConfigDraftMock.providers[0]!);
    const customTemplate = { ...structuredClone(providerTemplates[0]!), id: 'custom-template', source: 'custom' as const };
    const activeDraft = customProviderTemplateToDraft(customTemplate);
    const providerDraft = { ...providersPageHelpers.providerDraftToCustomProviderTemplateDraft(activeProvider), displayName: 'Changed' };
    const entries: ProviderTemplateCatalogEntry[] = providerTemplates.slice(0, 2).map((template, order) => ({ template, enabled: true, hidden: false, order }));
    let api!: ReturnType<typeof useProviderEditorController>;
    const setDragging = vi.fn(); const setPreferences = vi.fn(); const setCustomTemplates = vi.fn();
    const draggingRef = createRef<string | null>(); draggingRef.current = null;
    const movedRef = { current: false };
    const hoverRef = createRef<string | null>(); hoverRef.current = null;
    function Harness() {
      api = useProviderEditorController({ entries, draggingTemplateId: null, setDraggingTemplateId: setDragging,
        setTemplateCatalogPreferences: setPreferences, draggingTemplateIdRef: draggingRef,
        templateMouseDragMovedRef: movedRef, templateMouseHoverTargetRef: hoverRef, activeProvider,
        activeTemplate: customTemplate, activeCustomTemplateDraft: activeDraft, customTemplates: [customTemplate],
        providerDraftForCustomTemplate: providerDraft, sceneAssignments: activeProvider.sceneModelAssignments,
        setCustomTemplates, onTemplateChanged: vi.fn() });
      return null;
    }
    await act(async () => { root.render(<Harness />); await Promise.resolve(); });
    expect(setCustomTemplates).toHaveBeenCalled();

    api.applyTemplate(customTemplate);
    api.handleTemplateMouseDown({ button: 1 } as never, 'x');
    draggingRef.current = entries[0]!.template.id;
    api.handleTemplateMouseOver({ buttons: 1 } as never, 'missing-template');

    const newTemplate = { ...providerTemplates[1]!, id: 'new-template' };
    act(() => api.applyTemplate(newTemplate));
    expect(useAppStore.getState().configDraft.providers.some((provider) => provider.templateId === 'new-template')).toBe(true);

    providersPageHelpers.globalTemplateSceneAssignments.clear();
    const existingTemplate = providerTemplates.find((template) => template.id !== activeProvider.templateId)!;
    const existingDraft = { ...structuredClone(activeProvider), templateId: existingTemplate.id, displayName: existingTemplate.displayName };
    useAppStore.setState((state) => ({ ...state, configDraft: { ...state.configDraft,
      activeProviderTemplateId: activeProvider.templateId, providers: [activeProvider, existingDraft] } }));
    act(() => api.applyTemplate(existingTemplate));
    expect(useAppStore.getState().configDraft.activeProviderTemplateId).toBe(existingTemplate.id);

    const savedTemplate = { ...existingTemplate, id: 'saved-template' };
    providersPageHelpers.globalTemplateSceneAssignments.set(savedTemplate.id, activeProvider.sceneModelAssignments);
    useAppStore.setState((state) => ({ ...state, configDraft: { ...state.configDraft,
      activeProviderTemplateId: activeProvider.templateId, providers: [activeProvider] } }));
    act(() => api.applyTemplate(savedTemplate));
    expect(useAppStore.getState().configDraft.activeProviderTemplateId).toBe(savedTemplate.id);

    useAppStore.setState((state) => ({ ...state, configDraft: { ...state.configDraft,
      activeProviderTemplateId: activeProvider.templateId,
      providers: [activeProvider, { ...existingDraft, sceneModelAssignments: [] }],
    } }));
    act(() => api.applyTemplate(existingTemplate));
    expect(useAppStore.getState().configDraft.activeProviderTemplateId).toBe(existingTemplate.id);

    useAppStore.setState((state) => ({ ...state, configDraft: { ...state.configDraft, activeProviderTemplateId: '' } }));
    providersPageHelpers.globalTemplateSceneAssignments.set(providerTemplates[1]!.id, activeProvider.sceneModelAssignments);
    act(() => api.applyTemplate(providerTemplates[1]!));
    expect(setPreferences).not.toHaveBeenCalled();
  });

  it('covers empty, inferred, missing-entry, and no-op model editor paths', async () => {
    const activeProvider = structuredClone(appConfigDraftMock.providers[0]!);
    const activeTemplate = providerTemplates[0]!;
    const model: ProviderModelRuntime = { id: 'manual-model', displayName: 'Manual', ownedBy: null, createdAt: null, capabilities: [] };
    let params!: Parameters<typeof useProviderModelEditorController>[0];
    let api!: ReturnType<typeof useProviderModelEditorController>;
    function Harness() { api = useProviderModelEditorController(params); return null; }
    const base = {
      t: ((key: string) => key) as never, activeProvider, activeTemplate,
      sceneAssignments: activeProvider.sceneModelAssignments, localModelCapabilityRegistry: [],
      modelLookup: new Map<string, ProviderModelRuntime>(), modelCatalogSignature: 'sig', modelCatalogTargetScenario: 'watch' as const,
      manualModelIdDraft: '   ', pendingModelRegistration: null, draggingSceneModel: null, routeMode: 'watch' as const,
      providerRuntimeBlocked: false, providerRuntimeStatusMessage: null, setModelCatalog: vi.fn(),
      setModelCatalogTargetScenario: vi.fn(), setSelectedCatalogScenario: vi.fn(), setModelCatalogModalOpen: vi.fn(),
      setManualModelIdDraft: vi.fn(), setPendingModelRegistration: vi.fn(), refreshModelCatalog: vi.fn().mockResolvedValue(undefined),
    };
    params = base;
    await act(async () => root.render(<Harness />));
    act(() => api.handleManualModelAdd());
    act(() => api.handleCapabilityRegistryEntryToggle('missing', 'speech-to-text'));
    act(() => api.handleCapabilityRegistryInteractionToggle('missing', 'streaming'));
    act(() => api.handleSceneModelReorder('watch', 'missing'));
    expect(api.isModelAddedToScenario('all', 'missing')).toBe(false);
    expect(api.isModelAddedToScenario('watch', 'missing')).toBe(false);

    params = { ...base, manualModelIdDraft: model.id, modelLookup: new Map([[model.id, model]]) };
    await act(async () => root.render(<Harness />));
    act(() => api.handleManualModelAdd());
    expect(params.setPendingModelRegistration).toHaveBeenCalled();

    const inferredEntry = { id: 'entry', modelId: 'm', capabilities: ['speech-to-text' as const], realtimeAudioMode: undefined as never, interactionCapabilities: undefined as never };
    params = { ...base, localModelCapabilityRegistry: [inferredEntry] };
    await act(async () => root.render(<Harness />));
    act(() => api.handleCapabilityRegistryEntryChange('entry', { modelId: ' m ' }));
    act(() => api.handleCapabilityRegistryEntryToggle('entry', 'text-to-speech'));
    act(() => api.handleCapabilityRegistryInteractionToggle('entry', 'streaming'));
    expect(params.setModelCatalog).toHaveBeenCalled();

    useAppStore.setState((state) => ({ ...state, configDraft: { ...state.configDraft, providers: [] } }));
    act(() => api.handleSceneModelRemove('watch', activeProvider.model));
  });

  it('covers blocked catalog messages, missing scenarios, pending toggles, and registration guards', async () => {
    const activeProvider = structuredClone(appConfigDraftMock.providers[0]!);
    const activeTemplate = providerTemplates[0]!;
    const model: ProviderModelRuntime = { id: 'pending-model', displayName: 'Pending', ownedBy: null, createdAt: null, capabilities: [] };
    let pending: Parameters<typeof useProviderModelEditorController>[0]['pendingModelRegistration'] = null;
    const setPending = vi.fn((next: Parameters<typeof useProviderModelEditorController>[0]['setPendingModelRegistration'] extends (value: infer V) => void ? V : never) => {
      pending = typeof next === 'function' ? next(pending) : next;
    });
    let params!: Parameters<typeof useProviderModelEditorController>[0];
    let api!: ReturnType<typeof useProviderModelEditorController>;
    function Harness() { api = useProviderModelEditorController(params); return null; }
    const base = {
      t: ((key: string) => key) as never, activeProvider, activeTemplate,
      sceneAssignments: activeProvider.sceneModelAssignments, localModelCapabilityRegistry: [], modelLookup: new Map<string, ProviderModelRuntime>(),
      modelCatalogSignature: 'sig', modelCatalogTargetScenario: 'watch' as const, manualModelIdDraft: '', pendingModelRegistration: null,
      draggingSceneModel: null, routeMode: 'watch' as const, providerRuntimeBlocked: true, providerRuntimeStatusMessage: null,
      setModelCatalog: vi.fn(), setModelCatalogTargetScenario: vi.fn(), setSelectedCatalogScenario: vi.fn(), setModelCatalogModalOpen: vi.fn(),
      setManualModelIdDraft: vi.fn(), setPendingModelRegistration: setPending, refreshModelCatalog: vi.fn().mockResolvedValue(undefined),
    };
    params = base;
    await act(async () => root.render(<Harness />));
    act(() => api.handleModelCatalogOpen());
    expect(api.isModelAddedToScenario('missing' as never, 'none')).toBe(false);
    act(() => api.handlePendingRegistrationCapabilityToggle('speech-to-text'));
    act(() => api.handlePendingRegistrationInteractionToggle('streaming'));
    act(() => api.handlePendingRegistrationConfirm());

    pending = { scenario: 'watch', model, capabilities: ['speech-to-text'], realtimeAudioMode: 'server_vad', interactionCapabilities: ['streaming'] };
    params = { ...base, providerRuntimeStatusMessage: 'blocked', pendingModelRegistration: pending };
    await act(async () => root.render(<Harness />));
    act(() => api.handleModelCatalogOpen('game'));
    act(() => api.handlePendingRegistrationCapabilityToggle('speech-to-text'));
    act(() => api.handlePendingRegistrationCapabilityToggle('text-to-speech'));
    act(() => api.handlePendingRegistrationInteractionToggle('streaming'));
    act(() => api.handlePendingRegistrationInteractionToggle('auto_vad'));

    params = { ...params, pendingModelRegistration: { ...pending, capabilities: [] } };
    await act(async () => root.render(<Harness />));
    act(() => api.handlePendingRegistrationConfirm());
    params = { ...params, pendingModelRegistration: pending };
    await act(async () => root.render(<Harness />));
    act(() => api.handlePendingRegistrationConfirm());
    expect(useAppStore.getState().configDraft.providers[0]?.localModelCapabilityRegistry.some((entry) => entry.modelId === model.id)).toBe(true);
  });
});
