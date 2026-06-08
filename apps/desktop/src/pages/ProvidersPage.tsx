import { invoke } from '@tauri-apps/api/core';
import { type MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import AppIcon from '../components/icons/AppIcon';
import PageSectionHeader from '../components/page/PageSectionHeader';
import StatusBadge, { type StatusTone } from '../components/page/StatusBadge';
import { defaultProviderTemplate, providerTemplates } from '../mocks/provider-templates';
import type {
  ProviderCustomHeaderDraft,
  ProviderDraft,
  ProviderModelCapabilityRegistryEntry,
  ProviderModelCatalogCache,
  ProviderResponseModality,
  ProviderSceneModelAssignment,
  ProviderScenario,
} from '../schema/config';
import type { ProviderAuthScheme, ProviderCapability, ProviderInteractionCapability, ProviderKind, ProviderTransport } from '../schema/provider-contract';
import type { ProviderModelRuntime, ProviderProbeProfileRuntime, ProviderSmokeResult } from '../schema/provider-runtime';
import type { RuntimeSnapshot } from '../schema/runtime-core';
import type { ProviderTemplate } from '../schema/provider-template';
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
  formatProviderCapabilityShortLabel,
  formatProviderInteractionCapabilityLabel,
  formatProviderInteractionCapabilityShortLabel,
  formatRealtimeAudioModeLabel,
  inferInteractionCapabilitiesFromModelName,
  inferRealtimeAudioModeFromModelName,
  isRealtimeAudioMode,
  normalizeProviderInteractionCapabilityList,
  normalizeProviderCapabilityList,
  normalizeProviderModels,
  providerCapabilityOrder,
  providerInteractionCapabilityOrder,
  realtimeAudioModeOrder,
  resolveInteractionCapabilities,
  resolveProviderModelCapabilities,
} from '../utils/provider-model-capabilities';
import { getProbeVerdictLabel, getProbeVerdictTone, resolveProbeView } from '../utils/provider-probe';

import { providersPageHelpers, type ModelCatalogScenarioFilter, type ModelCatalogState, type PendingModelRegistration } from './providers/providersPageHelpers';
import CustomProviderDialog from './providers/CustomProviderDialog';
import ProviderModelCatalog from './providers/ProviderModelCatalog';
import ProviderVerificationPanel from './providers/ProviderVerificationPanel';
import ProviderTemplateCatalog from './providers/ProviderTemplateCatalog';
// eslint-disable-next-line react-refresh/only-export-components
export { providersPageHelpers } from './providers/providersPageHelpers';

const {
  formatTransportLabel,
  formatScenarioLabel,
  formatSmokeStatusLabel,
  formatRuntimeErrorMessage,
  resolveCapabilityIconName,
  defaultBaseUrlForKind,
  supportedTransportsForKind,
  defaultTransportForKind,
  defaultPromptTemplateForKind,
  createDefaultCustomProviderDraft,
  providerDraftToCustomProviderTemplateDraft,
  resolveBaseUrlForApiFormat,
  buildModelCatalogSignature,
  buildFallbackModels,
  createDerivedRuntimeModel,
  dedupeModels,
  createEmptyModelCatalogCache,
  createFallbackModelCatalog,
  createEmptyModelCatalog,
  hasCachedModelCatalog,
  buildModelCatalogStateFromCache,
  buildModelCatalogCache,
  globalTemplateSceneAssignments,
  ensureSceneAssignments,
  createCustomHeaderDraft,
  reorderTemplateEntries,
  addSceneModel,
  removeSceneModel,
  toggleResponseModalities,
  reorderSceneModels,
  getActiveProviderFromState,
} = providersPageHelpers;

function ProvidersPage() {
  const { t } = useTranslation();
  const configDraft = useAppStore((state) => state.configDraft);
  const runtimeSnapshot = useAppStore((state) => state.runtimeSnapshot);
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

  const [customTemplates, setCustomTemplates] = useState<ProviderTemplate[]>(() => readCustomProviderTemplates());
  const [templateCatalogPreferences, setTemplateCatalogPreferences] = useState<ProviderTemplateCatalogPreference[]>(() => readProviderTemplateCatalogPreferences());
  const [secretDraft, setSecretDraft] = useState('');
  const [secretStored, setSecretStored] = useState(false);
  const [busyAction, setBusyAction] = useState<'secret' | 'secret-reveal' | 'verify' | null>(null);
  const [probeResult, setProbeResult] = useState<ProviderProbeProfileRuntime | null>(null);
  const [smokeResult, setSmokeResult] = useState<ProviderSmokeResult | null>(null);
  const [secretStatusMessage, setSecretStatusMessage] = useState<string | null>(null);
  const [secretVisible, setSecretVisible] = useState(false);
  const [sampleText, setSampleText] = useState('????????????????????');
  const [templateQuery, setTemplateQuery] = useState('');
  const [customProviderDialogOpen, setCustomProviderDialogOpen] = useState(false);
  const [customProviderDraft, setCustomProviderDraft] = useState<CustomProviderTemplateDraft>(() => createDefaultCustomProviderDraft());
  const [customProviderError, setCustomProviderError] = useState<string | null>(null);
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  const [modelCatalogModalOpen, setModelCatalogModalOpen] = useState(false);
  const [capabilityRegistryModalOpen, setCapabilityRegistryModalOpen] = useState(false);
  const [audioModeHelpOpen, setAudioModeHelpOpen] = useState(false);
  const [verificationModalOpen, setVerificationModalOpen] = useState(false);
  const [selectedCatalogScenario, setSelectedCatalogScenario] = useState<ModelCatalogScenarioFilter>('all');
  const [modelCatalogTargetScenario, setModelCatalogTargetScenario] = useState<ProviderScenario>('watch');
  const [draggingTemplateId, setDraggingTemplateId] = useState<string | null>(null);
  const [draggingSceneModel, setDraggingSceneModel] = useState<{ scenario: ProviderScenario; modelId: string } | null>(null);
  const draggingTemplateIdRef = useRef<string | null>(null);
  const templateMouseDragMovedRef = useRef(false);
  const templateMouseHoverTargetRef = useRef<string | null>(null);
  const [manualModelIdDraft, setManualModelIdDraft] = useState('');
  const [pendingModelRegistration, setPendingModelRegistration] = useState<PendingModelRegistration | null>(null);
  const [modelCatalogQuery, setModelCatalogQuery] = useState('');
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogState>(() => createEmptyModelCatalog(buildModelCatalogSignature(activeProvider)));

  const storagePollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const storagePollAttemptsRef = useRef(0);
  const storagePollErrorRef = useRef<string | null>(null);
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
  const hasCapabilityRegistryEntry = (modelId: string) =>
    localModelCapabilityRegistry.some((entry) => entry.modelId.trim().toLowerCase() === modelId.trim().toLowerCase());

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
    queueMicrotask(() => setCustomTemplates(nextTemplates));
  }, [activeCustomTemplateDraft, activeTemplate, customTemplates, providerDraftForCustomTemplate]);

  // Initialized via lazy useState initializers above

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
    t('providers.modelCatalog.description', { scenario: formatScenarioLabel(modelCatalogTargetScenario) });

  const providerRuntimeStatusMessage = useMemo(() => {
    if (effectiveBridgeStatus === 'runtime-error') {
      return latestRuntimeError?.message ?? t('providers.messages.runtimeCoreUnavailable');
    }

    if (storageBlocked) {
      const storageDetail =
        runtimeSnapshot.storage.credentialBackend === 'browser-preview'
          ? t('providers.messages.storagePreviewDetail', { schemaVersion: runtimeSnapshot.storage.schemaVersion })
          : t('providers.messages.storageBackendDetail', { status: runtimeSnapshot.storage.status, backend: runtimeSnapshot.storage.credentialBackend, schemaVersion: runtimeSnapshot.storage.schemaVersion });
      return t('providers.messages.storageBlocked', { detail: storageDetail });
    }

    return null;
  }, [effectiveBridgeStatus, latestRuntimeError, runtimeSnapshot.storage, storageBlocked]);

  function blockedActionMessage(action: string): string {
    if (effectiveBridgeStatus === 'runtime-error') {
      return latestRuntimeError?.message ?? t('providers.messages.runtimeBlockedAction', { action });
    }

    return t('providers.messages.storageBlockedAction', { action });
  }

  
  const scheduleStoragePollErrorSync = () => {
    queueMicrotask(() => {
      setStoragePollError(storagePollErrorRef.current);
    });
  };

  useEffect(() => {
    if (!isTauriRuntime() || runtimeSnapshot.storage.status === 'ready' || effectiveBridgeStatus === 'runtime-error') {
      storagePollErrorRef.current = null;
      scheduleStoragePollErrorSync();

      return;
    }

    let active = true;
    storagePollAttemptsRef.current = 0;
    storagePollErrorRef.current = null;
    scheduleStoragePollErrorSync();

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

    queueMicrotask(() => {
      setSecretDraft('');
      setSecretVisible(false);
    });

    if (providerRuntimeBlocked) {
      queueMicrotask(() => {
        setSecretStored(false);
        setSecretStatusMessage(providerRuntimeStatusMessage);
      });
      return () => {
        active = false;
      };
    }

    const refreshSecret = async () => {
      try {
        await refreshProviderSecretStatus(activeProvider.authRef.reference);
        if (active) {
          setSecretStatusMessage(null);
        }
      } catch (error) {
        if (active) {
          setSecretStored(false);
          setSecretStatusMessage(formatRuntimeErrorMessage(t('providers.messages.secretStatusReadFailed'), error));
        }
      }
    };
    refreshSecret();

    return () => {
      active = false;
    };
  }, [activeProvider.authRef.reference, providerRuntimeBlocked, providerRuntimeStatusMessage]);

  const syncModelCatalogCache = (cache: ProviderModelCatalogCache) => {
    updateActiveProviderDraft({ modelCatalogCache: cache });
    syncProviderInArray({ ...getActiveProviderFromState(), modelCatalogCache: cache } as ProviderDraft);
  };

  const refreshModelCatalog = async () => {
    if (providerRuntimeBlocked) {
      setModelCatalog(createEmptyModelCatalog(modelCatalogSignature, 'error', providerRuntimeStatusMessage ?? blockedActionMessage(t('providers.actions.fetchModelList'))));
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
      const error = catalog.error?.message ?? (runtimeModels.length === 0 ? t('providers.messages.emptyModelCatalog') : null);
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
      setModelCatalog(createEmptyModelCatalog(modelCatalogSignature, 'error', formatRuntimeErrorMessage(t('providers.messages.fetchModelCatalogFailed'), error)));
    }
  };

  useEffect(() => {
    queueMicrotask(() => {
      setModelCatalog((current) => {
        if (hasCachedModelCatalog(activeProvider.modelCatalogCache, modelCatalogSignature)) {
          return current.signature === modelCatalogSignature && current.status === 'loading'
            ? current
            : buildModelCatalogStateFromCache(
                modelCatalogSignature,
                activeProvider.modelCatalogCache,
                activeTemplate,
                activeProvider.model,
                localModelCapabilityRegistry,
                activeProvider.baseUrl,
              );
        }

        return current.signature === modelCatalogSignature
          ? current
          : createEmptyModelCatalog(modelCatalogSignature);
      });
    });
  }, [
    activeTemplate,
    activeProvider.baseUrl,
    activeProvider.authRef.reference,
    activeProvider.kind,
    activeProvider.model,
    activeProvider.modelCatalogCache,
    localModelCapabilityRegistry,
    modelCatalogSignature,
    providerRuntimeBlocked,
  ]);

  

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
      setSecretStatusMessage(providerRuntimeStatusMessage ?? blockedActionMessage(t('providers.actions.saveSecret')));
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
      setSecretStatusMessage(t('providers.messages.secretSaved'));
      void refreshModelCatalog();
    } catch (error) {
      setSecretStatusMessage(formatRuntimeErrorMessage(t('providers.messages.secretWriteFailed'), error));
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
      setSecretStatusMessage(providerRuntimeStatusMessage ?? blockedActionMessage(t('providers.actions.readSecret')));
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
        setSecretStatusMessage(t('providers.messages.noStoredSecret'));
        return;
      }

      setSecretDraft(payload.secret);
      setSecretStored(true);
      setSecretVisible(true);
      setSecretStatusMessage(t('providers.messages.secretPlainLoaded'));
    } catch (error) {
      setSecretStatusMessage(formatRuntimeErrorMessage(t('providers.messages.secretPlainReadFailed'), error));
    } finally {
      setBusyAction(null);
    }
  };

  const handleVerificationRun = async () => {
    if (providerRuntimeBlocked) {
      setSecretStatusMessage(providerRuntimeStatusMessage ?? blockedActionMessage(t('providers.actions.verifyProvider')));
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
      setSecretStatusMessage(formatRuntimeErrorMessage(t('providers.messages.verifyFailed'), error));
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
      setCustomProviderError(t('providers.messages.providerNameRequired'));
      return;
    }

    if (!customProviderDraft.baseUrl.trim()) {
      setCustomProviderError(t('providers.messages.baseUrlRequired'));
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
        setSecretStatusMessage(t('providers.messages.keepOneProvider'));
        return;
      }

      updateTemplateCatalogEntries(nextEntries);
      applyTemplate(fallbackTemplate);
      setSecretStatusMessage(t('providers.messages.providerHidden'));
      return;
    }

    const nextTemplates = customTemplates.filter((template) => template.id !== activeTemplate.id);
    const nextEntries = buildProviderTemplateCatalogEntries([...providerTemplates, ...nextTemplates], templateCatalogPreferences);
    const fallbackTemplate = nextEntries.find((entry) => !entry.hidden && entry.template.id !== activeTemplate.id)?.template;

    if (!fallbackTemplate) {
      setSecretStatusMessage(t('providers.messages.keepOneProvider'));
      return;
    }

    writeCustomProviderTemplates(nextTemplates);
    setCustomTemplates(nextTemplates);
    applyTemplate(fallbackTemplate);
    updateProviders(
      useAppStore.getState().configDraft.providers.filter((provider) => provider.templateId !== activeTemplate.id),
    );
    setSecretStatusMessage(t('providers.messages.customProviderDeleted'));
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
      void refreshModelCatalog();
    } else {
      setModelCatalog(createEmptyModelCatalog(modelCatalogSignature, 'error', providerRuntimeStatusMessage ?? blockedActionMessage(t('providers.actions.fetchModelList'))));
    }
  };

  const handleSceneModelAdd = (scenario: ProviderScenario, model: ProviderModelRuntime) => {
    const nextAssignments = addSceneModel(sceneAssignments, scenario, model.id);
    updateSceneModelAssignments(nextAssignments, scenario === configDraft.devices.routeMode ? model.id : undefined);
  };

  const openPendingModelRegistration = (scenario: ProviderScenario, model: ProviderModelRuntime) => {
    const inferredCapabilities = resolveProviderModelCapabilities(model, localModelCapabilityRegistry);
    setPendingModelRegistration({
      scenario,
      model,
      capabilities: inferredCapabilities.length > 0 ? inferredCapabilities : [capabilityForScenario(scenario)],
      realtimeAudioMode: inferRealtimeAudioModeFromModelName(model.id, model.displayName),
      interactionCapabilities: inferInteractionCapabilitiesFromModelName(
        model.id,
        model.displayName,
        inferRealtimeAudioModeFromModelName(model.id, model.displayName),
      ),
    });
  };

  const handleManualModelAdd = () => {
    const modelId = manualModelIdDraft.trim();

    if (!modelId) {
      return;
    }

    const existingModel = modelLookup.get(modelId);
    const model = existingModel ?? createDerivedRuntimeModel(modelId, localModelCapabilityRegistry, 'manual');

    if (!hasCapabilityRegistryEntry(modelId)) {
      openPendingModelRegistration(modelCatalogTargetScenario, model);
      return;
    }

    handleSceneModelAdd(modelCatalogTargetScenario, model);
    setManualModelIdDraft('');
  };

  const handlePendingRegistrationCapabilityToggle = (capability: ProviderCapability) => {
    setPendingModelRegistration((current) => {
      if (!current) {
        return current;
      }
      const nextCapabilities = current.capabilities.includes(capability)
        ? current.capabilities.filter((item) => item !== capability)
        : [...current.capabilities, capability];
      return {
        ...current,
        capabilities: normalizeProviderCapabilityList(nextCapabilities),
      };
    });
  };

  const handlePendingRegistrationInteractionToggle = (capability: ProviderInteractionCapability) => {
    setPendingModelRegistration((current) => {
      if (!current) {
        return current;
      }
      const nextCapabilities = current.interactionCapabilities.includes(capability)
        ? current.interactionCapabilities.filter((item) => item !== capability)
        : [...current.interactionCapabilities, capability];
      return {
        ...current,
        interactionCapabilities: normalizeProviderInteractionCapabilityList(nextCapabilities),
      };
    });
  };

  const handlePendingRegistrationConfirm = () => {
    if (!pendingModelRegistration || pendingModelRegistration.capabilities.length === 0) {
      return;
    }
    const { scenario, model, capabilities, realtimeAudioMode, interactionCapabilities } = pendingModelRegistration;
    const nextRegistry = [
      createProviderModelCapabilityRegistryEntry(model.id, capabilities, realtimeAudioMode, interactionCapabilities),
      ...localModelCapabilityRegistry.filter((entry) => entry.modelId.trim().toLowerCase() !== model.id.trim().toLowerCase()),
    ];
    applyLocalModelCapabilityRegistry(nextRegistry);
    updateSceneModelAssignments(
      addSceneModel(sceneAssignments, scenario, model.id),
      scenario === configDraft.devices.routeMode ? model.id : undefined,
    );
    setManualModelIdDraft('');
    setPendingModelRegistration(null);
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

    if (!hasCapabilityRegistryEntry(model.id) && model.capabilities.length === 0) {
      openPendingModelRegistration(scenario, model);
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
      realtimeAudioMode: entry.realtimeAudioMode ?? inferRealtimeAudioModeFromModelName(entry.modelId),
      interactionCapabilities: normalizeProviderInteractionCapabilityList(
        entry.interactionCapabilities ?? inferInteractionCapabilitiesFromModelName(entry.modelId, undefined, entry.realtimeAudioMode),
      ),
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
      createProviderModelCapabilityRegistryEntry(modelId),
      ...localModelCapabilityRegistry,
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
              realtimeAudioMode: patch.realtimeAudioMode ?? entry.realtimeAudioMode,
              interactionCapabilities: patch.interactionCapabilities
                ? normalizeProviderInteractionCapabilityList(patch.interactionCapabilities)
                : entry.interactionCapabilities,
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

  const handleCapabilityRegistryInteractionToggle = (entryId: string, capability: ProviderInteractionCapability) => {
    const currentEntry = localModelCapabilityRegistry.find((entry) => entry.id === entryId);

    if (!currentEntry) {
      return;
    }

    const currentCapabilities = resolveInteractionCapabilities(currentEntry.modelId, [currentEntry]);
    const nextCapabilities = currentCapabilities.includes(capability)
      ? currentCapabilities.filter((item) => item !== capability)
      : [...currentCapabilities, capability];

    handleCapabilityRegistryEntryChange(entryId, { interactionCapabilities: nextCapabilities });
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
      <ProviderTemplateCatalog
        activeProvider={activeProvider}
        entries={filteredTemplateEntries}
        draggingTemplateId={draggingTemplateId}
        modelCatalogOpen={modelCatalogModalOpen}
        query={templateQuery}
        onAddProvider={openCreateCustomProviderDialog}
        onApplyTemplate={handleTemplateApply}
        onMouseDown={handleTemplateMouseDown}
        onMouseOver={handleTemplateMouseOver}
        onMouseUp={handleTemplateMouseUp}
        onQueryChange={setTemplateQuery}
        onToggleEnabled={handleTemplateEnabledToggle}
        templateDragMovedRef={templateMouseDragMovedRef}
      />

      <section className="provider-studio">
        <header className="provider-studio-header content-card page-card compact-card provider-studio-header-compact">
          <PageSectionHeader
            actions={(
              <>
                <button className="provider-header-icon provider-header-icon-danger" onClick={handleDeleteActiveCustomProvider} title={t('providers.actions.deleteCurrentProvider')} type="button">
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
                {busyAction === 'verify' ? t('providers.actions.verifying') : t('providers.actions.verifyProvider')}
              </button>
              {hasVerificationDetail ? (
                <button className="icon-button" onClick={() => setVerificationModalOpen(true)} type="button">
                  <AppIcon name="book" size={14} />
                  {t('providers.actions.verificationDetails')}
                </button>
              ) : null}
              <button className="icon-button" onClick={() => handleModelCatalogOpen()} type="button">
                <AppIcon name="layers" size={14} />
                {t('providers.actions.modelList')}
              </button>
              <button className="icon-button" onClick={() => setAdvancedSettingsOpen(true)} type="button">
                <AppIcon name="sliders" size={14} />
                {t('providers.actions.advancedSettings')}
              </button>
            </div>
          </div>

          {secretStatusMessage ? (
            <div
              className={`provider-inline-alert${
                secretStatusMessage === t('providers.messages.secretPlainLoaded') ? ' provider-inline-alert-plain' : ''
              }`}
            >
              {secretStatusMessage}
            </div>
          ) : null}
          {providerRuntimeStatusMessage && secretStatusMessage !== providerRuntimeStatusMessage ? (
            <div className="provider-inline-alert provider-inline-alert-warning">{providerRuntimeStatusMessage}</div>
          ) : null}
          {storagePollError ? <div className="provider-inline-alert provider-inline-alert-warning">{t('providers.messages.storageRecoveryFailed', { error: storagePollError })}</div> : null}
        </header>

        <div className="provider-studio-grid provider-studio-grid-compact provider-studio-grid-single">
          <div className="provider-studio-main">
            <article className="content-card page-card compact-card provider-panel-card provider-panel-card-compact">
              <div className="provider-panel-heading provider-panel-heading-compact">
                <div>
                  <h3>{t('providers.auth.title')}</h3>
                </div>
                <StatusBadge label={secretStored ? t('providers.auth.saved') : t('providers.auth.notSaved')} tone={secretStored ? 'ready' : 'draft'} />
              </div>

              <div className="provider-setting-block provider-setting-block-compact">
                <div className="provider-setting-header provider-setting-header-compact">
                  <div>
                    <strong>{t('providers.auth.credentialsHeader')}</strong>
                  </div>
                </div>
                <label className="field-stack provider-auth-entry-field">
                  <span>{t('providers.auth.apiUrl')}</span>
                  <div className="secret-input-inline provider-secret-input-inline">
                    <input className="text-input" onChange={(event) => updateActiveProviderDraft({ baseUrl: event.target.value, status: 'draft' })} value={activeProvider.baseUrl} />
                    <button className="icon-button secret-visibility-button" onClick={() => updateActiveProviderDraft({ baseUrl: activeTemplate.defaultDraft.baseUrl, status: 'draft' })} title={t('providers.auth.resetApiUrl')} type="button">
                      <AppIcon name="refresh" size={14} />
                    </button>
                  </div>
                </label>
                <label className="field-stack provider-auth-entry-field">
                  <span>{t('providers.auth.apiKey')}</span>
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
                        placeholder={t('providers.auth.secretPlaceholder')}
                        type={secretVisible ? 'text' : 'password'}
                        value={secretStored && !secretDraft ? '***********************************' : secretDraft}
                      />
                      <button
                        aria-label={secretVisible ? t('providers.auth.hideSecret') : t('providers.auth.showSecret')}
                        className="icon-button secret-visibility-button"
                        disabled={busyAction !== null || providerRuntimeBlocked}
                        onClick={() => void handleSecretVisibilityToggle()}
                        title={secretVisible ? t('providers.auth.hideSecret') : t('providers.auth.showSecret')}
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
                    {busyAction === 'secret' ? t('providers.actions.saving') : t('providers.actions.saveSecret')}
                  </button>
                </div>
                <div className="provider-footnote-row">
                  {modelCatalog.endpoint ? <p className="provider-setting-footnote">{t('providers.modelCatalog.endpoint', { endpoint: modelCatalog.endpoint })}</p> : null}
                </div>
              </div>
            </article>

            <article className="content-card page-card compact-card provider-panel-card provider-panel-card-compact">
              <div className="provider-panel-heading provider-panel-heading-compact">
                <div>
                  <h3>{t('providers.sceneModels.title')}</h3>
                </div>
                <div className="provider-panel-tools">
                  <StatusBadge label={t('providers.sceneModels.addedCount', { count: sceneAssignments.reduce((count, item) => count + item.modelIds.length, 0) })} tone="pending" />
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
                          <p>{sceneModels.length > 0 ? t('providers.sceneModels.addedCount', { count: sceneModels.length }) : t('providers.sceneModels.noneAdded')}</p>
                        </div>
                        <button className="icon-button" onClick={() => handleModelCatalogOpen(assignment.scenario)} type="button">
                          <AppIcon name="cloud" size={14} />
                          {t('providers.actions.addModel')}
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
                                  <span className="provider-setting-footnote">???</span>
                                )}
                                <button className="provider-header-icon provider-header-icon-danger" onClick={() => handleSceneModelRemove(assignment.scenario, model.id)} title={t('providers.actions.removeAddedModel')} type="button">
                                  <AppIcon name="close" size={13} />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="provider-directory-empty provider-scene-empty">
                          <strong>{t('providers.sceneModels.noneAdded')}</strong>
                          <p>{t('providers.sceneModels.emptyDescription')}</p>
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
        <ProviderModelCatalog
          catalog={modelCatalog}
          catalogSections={catalogSections}
          description={modelCatalogDescription}
          isModelAdded={isModelAddedToScenario}
          manualModelIdDraft={manualModelIdDraft}
          query={modelCatalogQuery}
          selectedScenario={selectedCatalogScenario}
          targetScenario={modelCatalogTargetScenario}
          uncategorizedModels={uncategorizedCatalogModels}
          onClose={() => setModelCatalogModalOpen(false)}
          onManualAdd={handleManualModelAdd}
          onManualDraftChange={setManualModelIdDraft}
          onOpenCapabilityRegistry={() => setCapabilityRegistryModalOpen(true)}
          onQueryChange={setModelCatalogQuery}
          onRefresh={() => void refreshModelCatalog()}
          onScenarioChange={setSelectedCatalogScenario}
          onToggleModel={handleCatalogModelToggle}
        />
      ) : null}

      {pendingModelRegistration ? (
        <div className="provider-modal-backdrop" onClick={() => setPendingModelRegistration(null)} role="presentation">
          <div aria-label={t('providers.pendingModel.title')} aria-modal="true" className="provider-modal provider-advanced-modal content-card page-card compact-card" onClick={(event) => event.stopPropagation()} role="dialog">
            <div className="provider-panel-heading provider-panel-heading-compact">
              <div>
                <h3>{t('providers.pendingModel.title')}</h3>
                <p>{pendingModelRegistration.model.id}</p>
              </div>
              <button className="provider-header-icon" onClick={() => setPendingModelRegistration(null)} title={t('providers.pendingModel.closeTitle')} type="button">
                <AppIcon name="close" size={13} />
              </button>
            </div>
            <div className="field-grid provider-field-grid provider-modal-grid">
              <div className="field-stack field-span-full">
                <span>{t('providers.pendingModel.capabilities')}</span>
                <div className="provider-scenario-switcher provider-capability-registry-pills">
                  {providerCapabilityOrder.map((capability) => (
                    <button
                      className={pendingModelRegistration.capabilities.includes(capability) ? 'provider-scenario-pill provider-scenario-pill-active' : 'provider-scenario-pill'}
                      key={`pending-${capability}`}
                      onClick={() => handlePendingRegistrationCapabilityToggle(capability)}
                      type="button"
                    >
                      {formatProviderCapabilityLabel(capability)}
                    </button>
                  ))}
                </div>
              </div>
              <label className="field-stack field-span-full">
                <span>{t('providers.pendingModel.realtimeAudioMode')}</span>
                <select
                  className="select-input"
                  onChange={(event) => {
                    const value = event.target.value;
                    setPendingModelRegistration((current) =>
                      current
                        ? {
                            ...current,
                            realtimeAudioMode: isRealtimeAudioMode(value) ? value : current.realtimeAudioMode,
                          }
                        : current,
                    );
                  }}
                  value={pendingModelRegistration.realtimeAudioMode}
                >
                  {realtimeAudioModeOrder.map((mode) => (
                    <option key={mode} value={mode}>
                      {formatRealtimeAudioModeLabel(mode)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="field-stack field-span-full">
                <span>Interaction capabilities</span>
                <div className="provider-scenario-switcher provider-capability-registry-pills">
                  {providerInteractionCapabilityOrder.map((capability) => (
                    <button
                      className={pendingModelRegistration.interactionCapabilities.includes(capability) ? 'provider-scenario-pill provider-scenario-pill-active' : 'provider-scenario-pill'}
                      key={`pending-interaction-${capability}`}
                      onClick={() => handlePendingRegistrationInteractionToggle(capability)}
                      title={formatProviderInteractionCapabilityLabel(capability)}
                      type="button"
                    >
                      {formatProviderInteractionCapabilityShortLabel(capability)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="provider-modal-actions">
              <button className="icon-button" onClick={() => setPendingModelRegistration(null)} type="button">
                {t('common.cancel')}
              </button>
              <button className="icon-button provider-primary-action" disabled={pendingModelRegistration.capabilities.length === 0} onClick={handlePendingRegistrationConfirm} type="button">
                {t('providers.pendingModel.registerAndAdd')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {capabilityRegistryModalOpen ? (
        <div className="provider-modal-backdrop" onClick={() => setCapabilityRegistryModalOpen(false)} role="presentation">
          <div aria-label={t('providers.capabilityRegistry.title')} aria-modal="true" className="provider-modal provider-advanced-modal content-card page-card compact-card" onClick={(event) => event.stopPropagation()} role="dialog">
            <div className="provider-panel-heading provider-panel-heading-compact">
              <div>
                <h3>{t('providers.capabilityRegistry.title')}</h3>
                <p>{t('providers.capabilityRegistry.description')}</p>
              </div>
              <div className="provider-model-toolbar">
                <button className="icon-button" onClick={() => handleCapabilityRegistryEntryAdd()} type="button">
                  <AppIcon name="cloud" size={14} />
                  {t('providers.capabilityRegistry.addEntry')}
                </button>
                <button className="provider-header-icon" onClick={() => setAudioModeHelpOpen(true)} title={t('providers.audioModeHelp.title')} type="button">
                  <AppIcon name="help-circle" size={13} />
                </button>
                <button className="provider-header-icon" onClick={() => setCapabilityRegistryModalOpen(false)} title={t('providers.capabilityRegistry.closeTitle')} type="button">
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
                      placeholder={t('providers.capabilityRegistry.modelIdPlaceholder')}
                      value={entry.modelId}
                    />
                    <div className="provider-scenario-switcher provider-capability-registry-pills">
                      {providerCapabilityOrder.map((capability) => (
                        <button
                          className={entry.capabilities.includes(capability) ? 'provider-scenario-pill provider-scenario-pill-active' : 'provider-scenario-pill'}
                          key={`${entry.id}-${capability}`}
                          onClick={() => handleCapabilityRegistryEntryToggle(entry.id, capability)}
                          title={formatProviderCapabilityLabel(capability)}
                          type="button"
                        >
                          {formatProviderCapabilityShortLabel(capability)}
                        </button>
                      ))}
                    </div>
                    <select
                      className="select-input provider-capability-mode-select"
                      onChange={(event) => {
                        const value = event.target.value;
                        handleCapabilityRegistryEntryChange(entry.id, {
                          realtimeAudioMode: isRealtimeAudioMode(value) ? value : inferRealtimeAudioModeFromModelName(entry.modelId),
                        });
                      }}
                      title={t('providers.pendingModel.realtimeAudioMode')}
                      value={entry.realtimeAudioMode ?? inferRealtimeAudioModeFromModelName(entry.modelId)}
                    >
                      {realtimeAudioModeOrder.map((mode) => (
                        <option key={mode} value={mode}>
                          {formatRealtimeAudioModeLabel(mode)}
                        </option>
                      ))}
                    </select>
                    <div className="provider-scenario-switcher provider-capability-registry-pills">
                      {providerInteractionCapabilityOrder.map((capability) => (
                        <button
                          className={(entry.interactionCapabilities ?? []).includes(capability) ? 'provider-scenario-pill provider-scenario-pill-active' : 'provider-scenario-pill'}
                          key={`${entry.id}-interaction-${capability}`}
                          onClick={() => handleCapabilityRegistryInteractionToggle(entry.id, capability)}
                          title={formatProviderInteractionCapabilityLabel(capability)}
                          type="button"
                        >
                          {formatProviderInteractionCapabilityShortLabel(capability)}
                        </button>
                      ))}
                    </div>
                    <button className="provider-header-icon provider-header-icon-danger" onClick={() => handleCapabilityRegistryEntryRemove(entry.id)} title={t('providers.capabilityRegistry.deleteEntry')} type="button">
                      <AppIcon name="close" size={13} />
                    </button>
                  </div>
                ))
              ) : (
                <div className="provider-directory-empty provider-scene-empty">
                  <strong>{t('providers.capabilityRegistry.emptyTitle')}</strong>
                  <p>{t('providers.capabilityRegistry.emptyDescription')}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {audioModeHelpOpen ? (
        <div className="provider-modal-backdrop" onClick={() => setAudioModeHelpOpen(false)} role="presentation">
          <div aria-label={t('providers.audioModeHelp.title')} aria-modal="true" className="provider-modal provider-advanced-modal content-card page-card compact-card" onClick={(event) => event.stopPropagation()} role="dialog">
            <div className="provider-panel-heading provider-panel-heading-compact">
              <div>
                <h3>{t('providers.audioModeHelp.title')}</h3>
                <p>{t('providers.audioModeHelp.description')}</p>
              </div>
              <button className="provider-header-icon" onClick={() => setAudioModeHelpOpen(false)} title={t('providers.audioModeHelp.closeTitle')} type="button">
                <AppIcon name="close" size={13} />
              </button>
            </div>

            <div className="audio-mode-help-list">
              <div className="audio-mode-help-item">
                <div className="audio-mode-help-header">
                  <span className="audio-mode-help-name">{t('providers.audioModeHelp.manualFullAudio.name')}</span>
                  <span className="audio-mode-help-tag">DashScope Omni</span>
                  <span className="audio-mode-help-tag audio-mode-help-tag-client">{t('providers.audioModeHelp.clientSegmentation')}</span>
                </div>
                <p className="audio-mode-help-desc">
                  {t('providers.audioModeHelp.manualFullAudio.description')}
                </p>
                <p className="audio-mode-help-models">{t('providers.audioModeHelp.manualFullAudio.models')}</p>
              </div>

              <div className="audio-mode-help-item">
                <div className="audio-mode-help-header">
                  <span className="audio-mode-help-name">{t('providers.audioModeHelp.serverVad.name')}</span>
                  <span className="audio-mode-help-tag">DashScope / OpenAI</span>
                  <span className="audio-mode-help-tag audio-mode-help-tag-server">{t('providers.audioModeHelp.serverSegmentation')}</span>
                </div>
                <p className="audio-mode-help-desc">
                  {t('providers.audioModeHelp.serverVad.description')}
                </p>
                <p className="audio-mode-help-models">{t('providers.audioModeHelp.serverVad.models')}</p>
              </div>

              <div className="audio-mode-help-item">
                <div className="audio-mode-help-header">
                  <span className="audio-mode-help-name">{t('providers.audioModeHelp.semanticVad.name')}</span>
                  <span className="audio-mode-help-tag">DashScope Omni</span>
                  <span className="audio-mode-help-tag audio-mode-help-tag-server">{t('providers.audioModeHelp.serverSegmentation')}</span>
                </div>
                <p className="audio-mode-help-desc">
                  {t('providers.audioModeHelp.semanticVad.description')}
                </p>
                <p className="audio-mode-help-models">{t('providers.audioModeHelp.semanticVad.models')}</p>
              </div>

              <div className="audio-mode-help-item">
                <div className="audio-mode-help-header">
                  <span className="audio-mode-help-name">{t('providers.audioModeHelp.geminiAuto.name')}</span>
                  <span className="audio-mode-help-tag">Gemini Live</span>
                  <span className="audio-mode-help-tag audio-mode-help-tag-server">Google {t('providers.audioModeHelp.serverSegmentation')}</span>
                </div>
                <p className="audio-mode-help-desc">
                  {t('providers.audioModeHelp.geminiAuto.description')}
                </p>
                <p className="audio-mode-help-models">{t('providers.audioModeHelp.geminiAuto.models')}</p>
              </div>

              <div className="audio-mode-help-item">
                <div className="audio-mode-help-header">
                  <span className="audio-mode-help-name">{t('providers.audioModeHelp.geminiManual.name')}</span>
                  <span className="audio-mode-help-tag">Gemini Live</span>
                  <span className="audio-mode-help-tag audio-mode-help-tag-client">{t('providers.audioModeHelp.clientSegmentation')}</span>
                </div>
                <p className="audio-mode-help-desc">
                  {t('providers.audioModeHelp.geminiManual.description')}
                </p>
                <p className="audio-mode-help-models">{t('providers.audioModeHelp.geminiManual.models')}</p>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {advancedSettingsOpen ? (
        <div className="provider-modal-backdrop" onClick={() => setAdvancedSettingsOpen(false)} role="presentation">
          <div aria-label="{t('providers.actions.advancedSettings')}" aria-modal="true" className="provider-modal provider-advanced-modal content-card page-card compact-card" onClick={(event) => event.stopPropagation()} role="dialog">
            <div className="provider-panel-heading provider-panel-heading-compact">
              <div>
                <h3>{t('providers.actions.advancedSettings')}</h3>
              </div>
              <button className="provider-header-icon" onClick={() => setAdvancedSettingsOpen(false)} title={t('providers.advanced.closeTitle')} type="button">
                <AppIcon name="close" size={13} />
              </button>
            </div>

            <div className="field-grid provider-field-grid provider-modal-grid">
              <label className="field-stack">
                <span>{t('providers.advanced.displayName')}</span>
                <input className="text-input" onChange={(event) => updateActiveProviderDraft({ displayName: event.target.value, status: 'draft' })} value={activeProvider.displayName} />
              </label>
              <label className="field-stack">
                <span>{t('providers.advanced.apiFormat')}</span>
                <select className="select-input" onChange={(event) => handleProviderKindChange(event.target.value as ProviderKind)} value={activeProvider.kind}>
                  <option value="openai-compatible">OpenAI API compatible</option>
                  <option value="dashscope">DashScope API</option>
                  <option value="openrouter">OpenRouter</option>
                  <option value="nvidia">NVIDIA</option>
                  <option value="ollama">Ollama</option>
                  <option value="lmstudio">LM Studio</option>
                </select>
              </label>
              <label className="field-stack field-span-full">
                <span>{t('providers.advanced.endpointUrl')}</span>
                <input className="text-input" onChange={(event) => updateActiveProviderDraft({ baseUrl: event.target.value, status: 'draft' })} value={activeProvider.baseUrl} />
              </label>
              <label className="field-stack">
                <span>{t('providers.advanced.transport')}</span>
                <select className="select-input" onChange={(event) => updateActiveProviderDraft({ transport: event.target.value as ProviderTransport, status: 'draft' })} value={activeProvider.transport}>
                  {supportedTransportsForKind(activeProvider.kind).map((transport) => (
                    <option key={transport} value={transport}>
                      {formatTransportLabel(transport)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-stack">
                <span>{t('providers.advanced.timeout')}</span>
                <input className="text-input" min={1000} onChange={(event) => updateActiveProviderDraft({ timeoutMs: Number(event.target.value) || 0, status: 'draft' })} step={500} type="number" value={activeProvider.timeoutMs} />
              </label>
              <label className="field-stack">
                <span>{t('providers.advanced.authScheme')}</span>
                <select className="select-input" onChange={(event) => updateActiveProviderDraft({ authRef: { ...activeProvider.authRef, scheme: event.target.value as ProviderAuthScheme }, status: 'draft' })} value={activeProvider.authRef.scheme}>
                  <option value="bearer">Bearer</option>
                  <option value="api-key">API Key</option>
                  <option value="none">{t('providers.common.none')}</option>
                </select>
              </label>
              <label className="field-stack">
                <span>{t('providers.advanced.authHeader')}</span>
                <input className="text-input" onChange={(event) => updateActiveProviderDraft({ authRef: { ...activeProvider.authRef, headerName: event.target.value }, status: 'draft' })} value={activeProvider.authRef.headerName} />
              </label>
              <label className="field-stack">
                <span>{t('providers.advanced.streaming')}</span>
                <select className="select-input" onChange={(event) => updateActiveProviderDraft({ streamEnabled: event.target.value === 'true', status: 'draft' })} value={String(activeProvider.streamEnabled)}>
                  <option value="true">{t('providers.common.enabled')}</option>
                  <option value="false">{t('providers.common.disabled')}</option>
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
                  <span>{t('providers.advanced.region')}</span>
                  <input className="text-input" onChange={(event) => updateActiveProviderDraft({ region: event.target.value, status: 'draft' })} value={activeProvider.region} />
                </label>
              ) : null}
              <label className="field-stack field-span-full">
                <span>{t('providers.advanced.sampleText')}</span>
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
                      {modality === 'text' ? t('providers.common.text') : t('providers.common.audio')}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <section className="provider-setting-block provider-setting-block-compact">
              <div className="provider-setting-header provider-setting-header-compact">
                <div>
                  <strong>{t('providers.customHeaders.title')}</strong>
                </div>
                <button className="icon-button" onClick={handleProviderCustomHeaderAdd} type="button">
                  <AppIcon name="cloud" size={14} />
                  {t('providers.customHeaders.addHeader')}
                </button>
              </div>

              <div className="provider-custom-header-list">
                {activeProvider.customHeaders.length > 0 ? (
                  activeProvider.customHeaders.map((header) => (
                    <div className="provider-custom-header-item" key={header.id}>
                      <input className="text-input" onChange={(event) => handleProviderCustomHeaderChange(header.id, { name: event.target.value })} placeholder={t('providers.customHeaders.namePlaceholder')} value={header.name} />
                      <input className="text-input" onChange={(event) => handleProviderCustomHeaderChange(header.id, { value: event.target.value })} placeholder={t('providers.customHeaders.valuePlaceholder')} value={header.value} />
                      <select className="select-input" onChange={(event) => handleProviderCustomHeaderChange(header.id, { enabled: event.target.value === 'true' })} value={String(header.enabled)}>
                        <option value="true">{t('providers.common.enabled')}</option>
                        <option value="false">{t('providers.common.disabled')}</option>
                      </select>
                      <button className="provider-header-icon provider-header-icon-danger" onClick={() => handleProviderCustomHeaderRemove(header.id)} title={t('providers.customHeaders.deleteHeader')} type="button">
                        <AppIcon name="close" size={13} />
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="provider-directory-empty provider-scene-empty">
                    <strong>{t('providers.customHeaders.emptyTitle')}</strong>
                    <p>{t('providers.customHeaders.emptyDescription')}</p>
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      ) : null}

      {verificationModalOpen ? (
        <ProviderVerificationPanel
          activeProbe={activeProbe}
          probeResult={probeResult}
          smokeResult={smokeResult}
          summaryLabel={verificationSummaryLabel}
          summaryTone={verificationSummaryTone}
          onClose={() => setVerificationModalOpen(false)}
        />
      ) : null}

      {customProviderDialogOpen ? (
        <CustomProviderDialog
          draft={customProviderDraft}
          error={customProviderError}
          onClose={closeCustomProviderDialog}
          onKindChange={handleCustomProviderKindChange}
          onSave={handleCustomProviderSave}
          setDraft={setCustomProviderDraft}
        />
      ) : null}
    </div>
  );
}

export default ProvidersPage;
