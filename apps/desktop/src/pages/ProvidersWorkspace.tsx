import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { StatusTone } from '../components/page/StatusBadge';
import { defaultProviderTemplate, providerTemplates } from '../defaults/provider-templates';
import type { ProviderKind } from '../schema/provider-contract';
import { resolveRuntimeBridgeStatus } from '../runtime/runtime-status';
import { useDesktopCapabilities } from '../runtime/desktop-api-context';
import { useProviderWorkspaceStoreSlices } from '../stores/app-store-slices';
import { buildProviderTemplateCatalogEntries } from '../utils/provider-template-catalog';
import {
  createCustomProviderTemplate,
  customProviderTemplateToDraft,
} from '../utils/custom-provider-templates';
import { getProbeVerdictLabel, getProbeVerdictTone, resolveProbeView } from '../utils/provider-probe';

import { providersPageHelpers } from './providers/providersPageHelpers';
import CustomProviderDialog from './providers/CustomProviderDialog';
import ProviderModelCatalog from './providers/ProviderModelCatalog';
import ProviderVerificationPanel from './providers/ProviderVerificationPanel';
import ProviderTemplateCatalog from './providers/ProviderTemplateCatalog';
import ProviderStudio from './providers/ProviderStudio';
import { AudioModeHelpDialog, PendingModelRegistrationDialog } from './providers/ProviderModelDialogs';
import ProviderAdvancedSettingsDialog from './providers/ProviderAdvancedSettingsDialog';
import ProviderCapabilityRegistryDialog from './providers/ProviderCapabilityRegistryDialog';
import { useStorageRecovery } from './providers/useStorageRecovery';
import { useProviderWorkspaceController } from './providers/useProviderWorkspaceController';
import { useProviderVerificationController } from './providers/useProviderVerificationController';
import { useProviderEditorController } from './providers/useProviderEditorController';
import { useProviderModelEditorController } from './providers/useProviderModelEditorController';
import { useProviderCatalogProjection } from './providers/useProviderCatalogProjection';
// eslint-disable-next-line react-refresh/only-export-components
export { providersPageHelpers } from './providers/providersPageHelpers';

const {
  formatScenarioLabel,
  formatSmokeStatusLabel,
  defaultBaseUrlForKind,
  supportedTransportsForKind,
  defaultTransportForKind,
  defaultPromptTemplateForKind,
  createDefaultCustomProviderDraft,
  providerDraftToCustomProviderTemplateDraft,
  resolveBaseUrlForApiFormat,
  buildModelCatalogSignature,
  buildFallbackModels,
  dedupeModels,
  createEmptyModelCatalogCache,
  createFallbackModelCatalog,
  ensureSceneAssignments,
} = providersPageHelpers;

function ProvidersPage() {
  const { hasNativeShell } = useDesktopCapabilities();
  const { t } = useTranslation();
  const { configDraft, runtimeSnapshot, runtimeNotifications, updateActiveProviderDraft, setRuntimeSnapshot } = useProviderWorkspaceStoreSlices();

  const activeProvider = useMemo(
    () => configDraft.providers.find((p) => p.templateId === configDraft.activeProviderTemplateId) ?? configDraft.providers[0],
    [configDraft.providers, configDraft.activeProviderTemplateId],
  );

  const {
    customTemplates, setCustomTemplates, customTemplateReadError, templateCatalogPreferences, setTemplateCatalogPreferences,
    secretDraft, setSecretDraft, secretStored, setSecretStored, busyAction, setBusyAction,
    probeResult, setProbeResult, smokeResult, setSmokeResult,
    secretStatusMessage, setSecretStatusMessage, secretVisible, setSecretVisible,
    sampleText, setSampleText, templateQuery, setTemplateQuery,
    customProviderDialogOpen, setCustomProviderDialogOpen,
    customProviderDraft, setCustomProviderDraft, customProviderError, setCustomProviderError,
    advancedSettingsOpen, setAdvancedSettingsOpen, modelCatalogModalOpen, setModelCatalogModalOpen,
    capabilityRegistryModalOpen, setCapabilityRegistryModalOpen,
    audioModeHelpOpen, setAudioModeHelpOpen, verificationModalOpen, setVerificationModalOpen,
    selectedCatalogScenario, setSelectedCatalogScenario,
    modelCatalogTargetScenario, setModelCatalogTargetScenario,
    draggingTemplateId, setDraggingTemplateId, draggingSceneModel, setDraggingSceneModel,
    draggingTemplateIdRef, templateMouseDragMovedRef, templateMouseHoverTargetRef,
    manualModelIdDraft, setManualModelIdDraft, pendingModelRegistration, setPendingModelRegistration,
    modelCatalogQuery, setModelCatalogQuery, modelCatalog, setModelCatalog,
  } = useProviderWorkspaceController(activeProvider);


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
  const storageBlocked = hasNativeShell && runtimeSnapshot.storage.status !== 'ready';
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

  // Initialized via lazy useState initializers above

  const { catalogSections, filteredTemplateEntries, uncategorizedCatalogModels } = useProviderCatalogProjection({
    modelCatalog,
    modelCatalogQuery,
    selectedCatalogScenario,
    templateEntries: visibleTemplateEntries,
    templateQuery,
  });
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
  }, [effectiveBridgeStatus, latestRuntimeError, runtimeSnapshot.storage, storageBlocked, t]);

  const { failure: storagePollError, retry: retryStorageRecovery } = useStorageRecovery({
    runtimeStatus: runtimeSnapshot.storage.status,
    bridgeStatus: effectiveBridgeStatus,
    setRuntimeSnapshot,
  });

  const {
    handleSecretSave,
    handleSecretVisibilityToggle,
    handleVerificationRun,
    refreshModelCatalog,
    resetForTemplate,
  } = useProviderVerificationController({
    t,
    activeProvider,
    activeTemplate,
    providerRuntimeBlocked,
    providerRuntimeStatusMessage,
    sourceLanguage: configDraft.subtitles.sourceLanguage,
    targetLanguage: configDraft.subtitles.targetLanguage,
    sampleText,
    secretDraft,
    secretVisible,
    setBusyAction,
    setProbeResult,
    setSmokeResult,
    setSecretDraft,
    setSecretStored,
    setSecretStatusMessage,
    setSecretVisible,
    setVerificationModalOpen,
    modelCatalogSignature,
    localModelCapabilityRegistry,
    setModelCatalog,
  });

  const {
    updateTemplateCatalogEntries,
    handleTemplateEnabledToggle,
    handleTemplateMouseDown,
    handleTemplateMouseOver,
    handleTemplateMouseUp,
    applyTemplate,
    persistCustomTemplates,
    removeProviderDraft,
  } = useProviderEditorController({
    entries: allTemplateEntries,
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
    onTemplateChanged: resetForTemplate,
  });

  const handleTemplateApply = (templateId: string) => {
    const template = allTemplates.find((item) => item.id === templateId)!;
    applyTemplate(template);
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
      region: kind === 'dashscope' ? 'cn-beijing' : '',
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

    if (!persistCustomTemplates(nextTemplates)) {
      setCustomProviderError(t('providers.messages.customProviderSaveFailed', { defaultValue: '自定义提供商保存失败，请检查本地存储权限后重试。' }));
      return;
    }

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

    if (!persistCustomTemplates(nextTemplates)) return;
    applyTemplate(fallbackTemplate);
    removeProviderDraft(activeTemplate.id);
    setSecretStatusMessage(t('providers.messages.customProviderDeleted'));
  };

  const {
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
  } = useProviderModelEditorController({
    t,
    activeProvider,
    activeTemplate,
    sceneAssignments,
    localModelCapabilityRegistry,
    modelLookup,
    modelCatalogSignature,
    modelCatalogTargetScenario,
    manualModelIdDraft,
    pendingModelRegistration,
    draggingSceneModel,
    routeMode: configDraft.devices.routeMode,
    providerRuntimeBlocked,
    providerRuntimeStatusMessage,
    setModelCatalog,
    setModelCatalogTargetScenario,
    setSelectedCatalogScenario,
    setModelCatalogModalOpen,
    setManualModelIdDraft,
    setPendingModelRegistration,
    refreshModelCatalog,
  });
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

      <ProviderStudio
        activeProvider={activeProvider}
        activeTemplate={activeTemplate}
        busyAction={busyAction}
        providerRuntimeBlocked={providerRuntimeBlocked}
        providerRuntimeStatusMessage={providerRuntimeStatusMessage ?? customTemplateReadError}
        storagePollError={storagePollError}
        onStorageRetry={retryStorageRecovery}
        hasVerificationDetail={hasVerificationDetail}
        secretDraft={secretDraft}
        secretStored={secretStored}
        secretVisible={secretVisible}
        secretStatusMessage={secretStatusMessage}
        modelCatalogEndpoint={modelCatalog.endpoint}
        sceneAssignments={sceneAssignments}
        modelLookup={modelLookup}
        localModelCapabilityRegistry={localModelCapabilityRegistry}
        setSecretDraft={setSecretDraft}
        setDraggingSceneModel={setDraggingSceneModel}
        updateActiveProviderDraft={updateActiveProviderDraft}
        onDelete={handleDeleteActiveCustomProvider}
        onVerify={handleVerificationRun}
        onVerificationDetails={() => setVerificationModalOpen(true)}
        onOpenModelCatalog={handleModelCatalogOpen}
        onOpenAdvancedSettings={() => setAdvancedSettingsOpen(true)}
        onSecretVisibilityToggle={handleSecretVisibilityToggle}
        onSecretSave={handleSecretSave}
        onSceneModelReorder={handleSceneModelReorder}
        onSceneModelRemove={handleSceneModelRemove}
      />

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
        <PendingModelRegistrationDialog
          pending={pendingModelRegistration}
          onChange={setPendingModelRegistration}
          onCapabilityToggle={handlePendingRegistrationCapabilityToggle}
          onInteractionToggle={handlePendingRegistrationInteractionToggle}
          onConfirm={handlePendingRegistrationConfirm}
          onClose={() => setPendingModelRegistration(null)}
        />
      ) : null}

      {capabilityRegistryModalOpen ? (
        <ProviderCapabilityRegistryDialog
          entries={localModelCapabilityRegistry}
          modelIdSuggestions={[...modelLookup.keys()]}
          onClose={() => setCapabilityRegistryModalOpen(false)}
          onOpenHelp={() => setAudioModeHelpOpen(true)}
          onAdd={() => handleCapabilityRegistryEntryAdd()}
          onChange={handleCapabilityRegistryEntryChange}
          onCapabilityToggle={handleCapabilityRegistryEntryToggle}
          onInteractionToggle={handleCapabilityRegistryInteractionToggle}
          onRemove={handleCapabilityRegistryEntryRemove}
        />
      ) : null}

      {audioModeHelpOpen ? <AudioModeHelpDialog onClose={() => setAudioModeHelpOpen(false)} /> : null}

      {advancedSettingsOpen ? (
        <ProviderAdvancedSettingsDialog
          provider={activeProvider}
          sampleText={sampleText}
          onClose={() => setAdvancedSettingsOpen(false)}
          onProviderChange={updateActiveProviderDraft}
          onKindChange={handleProviderKindChange}
          onSampleTextChange={setSampleText}
          onResponseModalityToggle={handleResponseModalityToggle}
          onHeaderAdd={handleProviderCustomHeaderAdd}
          onHeaderChange={handleProviderCustomHeaderChange}
          onHeaderRemove={handleProviderCustomHeaderRemove}
        />
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
