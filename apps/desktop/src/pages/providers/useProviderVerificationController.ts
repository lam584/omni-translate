import { beginCredentialVerificationChange, credentialVerificationPending, credentialVerificationRevision, subscribeCredentialVerification } from '../../utils/provider-credential-verification';
import { providerVerificationIdentity } from '../../utils/provider-draft-verification';
import type { TFunction } from 'i18next';
import { useEffect, useRef, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import { fetchProviderModelMetadata, fetchProviderModels, getProviderSecretStatus, readProviderSecret, runProviderProbe, runProviderSmoke, saveProviderSecret } from '../../runtime/provider-runtime';
import type { ProviderDraft, ProviderModelCapabilityRegistryEntry } from '../../schema/config';
import type { ProviderProbeProfileRuntime, ProviderSmokeResult } from '../../schema/provider-runtime';
import type { ProviderTemplate } from '../../schema/provider-template';
import { useAppStore } from '../../stores/app-store';
import { buildProviderDraftPatchFromTemplate, buildProviderVerificationPatch } from '../../utils/provider-draft';
import { normalizeProviderModels } from '../../utils/provider-model-capabilities';
import { providersPageHelpers, type ModelCatalogState } from './providersPageHelpers';

type BusyAction = 'secret' | 'secret-reveal' | 'verify' | null;

type Params = {
  t: TFunction;
  activeProvider: ProviderDraft;
  activeTemplate: ProviderTemplate;
  providerRuntimeBlocked: boolean;
  providerRuntimeStatusMessage: string | null;
  sourceLanguage: string;
  targetLanguage: string;
  sampleText: string;
  secretDraft: string;
  secretVisible: boolean;
  setBusyAction: Dispatch<SetStateAction<BusyAction>>;
  setProbeResult: Dispatch<SetStateAction<ProviderProbeProfileRuntime | null>>;
  setSmokeResult: Dispatch<SetStateAction<ProviderSmokeResult | null>>;
  setSecretDraft: Dispatch<SetStateAction<string>>;
  setSecretStored: Dispatch<SetStateAction<boolean>>;
  setSecretStatusMessage: Dispatch<SetStateAction<string | null>>;
  setSecretVisible: Dispatch<SetStateAction<boolean>>;
  setVerificationModalOpen: Dispatch<SetStateAction<boolean>>;
  modelCatalogSignature: string;
  localModelCapabilityRegistry: ProviderModelCapabilityRegistryEntry[];
  setModelCatalog: Dispatch<SetStateAction<ModelCatalogState>>;
};

export function useProviderVerificationController(params: Params) {
  const { activeProvider, activeTemplate, localModelCapabilityRegistry, modelCatalogSignature,
    providerRuntimeBlocked, providerRuntimeStatusMessage, setModelCatalog, setSecretDraft,
    setSecretStatusMessage, setSecretStored, setSecretVisible, t } = params;
  const refreshRevision = useRef(0);
  useEffect(() => () => { refreshRevision.current += 1; }, [activeProvider.providerId, activeProvider.templateId]);
  const credentialRevision = useSyncExternalStore(subscribeCredentialVerification, () => credentialVerificationRevision(activeProvider.authRef.reference));
  const verificationIdentity = providerVerificationIdentity(activeProvider);
  const mountedIdentity = useRef<string | null>(verificationIdentity);
  useEffect(() => {
    mountedIdentity.current = verificationIdentity;
    return () => { mountedIdentity.current = null; };
  }, [verificationIdentity]);
  const { setProbeResult, setSmokeResult } = params;
  useEffect(() => {
    queueMicrotask(() => { setProbeResult(null); setSmokeResult(null); });
  }, [verificationIdentity, credentialRevision, setProbeResult, setSmokeResult]);
  const verificationStillCurrent = () => {
    const current = useAppStore.getState().configDraft.providers.find((provider) => provider.providerId === activeProvider.providerId && provider.templateId === activeProvider.templateId);
    return mountedIdentity.current === verificationIdentity && !credentialVerificationPending(activeProvider.authRef.reference) && credentialVerificationRevision(activeProvider.authRef.reference) === credentialRevision && current !== undefined && providerVerificationIdentity(current) === verificationIdentity;
  };
  const updateActiveProviderDraft = (patch: Partial<ProviderDraft>) => {
    const state = useAppStore.getState();
    state.updateProviders(state.configDraft.providers.map((provider) =>
      provider.providerId === activeProvider.providerId && provider.templateId === activeProvider.templateId
        ? { ...provider, ...patch } : provider));
  };
  const updateDiagnosticsDraft = useAppStore((state) => state.updateDiagnosticsDraft);
  const blockedMessage = (action: string) => params.providerRuntimeStatusMessage
    ?? params.t('providers.messages.storageBlockedAction', { action });

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
      return () => { active = false; };
    }
    void getProviderSecretStatus(activeProvider.authRef.reference).then((status) => {
      if (!active) return;
      setSecretStored(status.hasSecret);
      setSecretStatusMessage(null);
    }).catch((error) => {
      if (!active) return;
      setSecretStored(false);
      setSecretStatusMessage(providersPageHelpers.formatRuntimeErrorMessage(
        t('providers.messages.secretStatusReadFailed'), error,
      ));
    });
    return () => { active = false; };
  }, [activeProvider.authRef.reference, providerRuntimeBlocked, providerRuntimeStatusMessage,
    setSecretDraft, setSecretStatusMessage, setSecretStored, setSecretVisible, t]);

  useEffect(() => {
    queueMicrotask(() => setModelCatalog((current) => {
      if (providersPageHelpers.hasCachedModelCatalog(activeProvider.modelCatalogCache, modelCatalogSignature)) {
        return current.signature === modelCatalogSignature && current.status === 'loading' ? current
          : providersPageHelpers.buildModelCatalogStateFromCache(modelCatalogSignature,
            activeProvider.modelCatalogCache, activeTemplate, activeProvider.model,
            localModelCapabilityRegistry, activeProvider.baseUrl);
      }
      return current.signature === modelCatalogSignature ? current
        : providersPageHelpers.createEmptyModelCatalog(modelCatalogSignature);
    }));
  }, [activeProvider.baseUrl, activeProvider.model, activeProvider.modelCatalogCache,
    activeTemplate, localModelCapabilityRegistry, modelCatalogSignature, setModelCatalog]);

  const setVerificationStatus = (status: 'ready' | 'warning') => {
    updateActiveProviderDraft({ status });
    updateDiagnosticsDraft({ providerStatus: status });
  };

  const syncProbeState = (result: ProviderProbeProfileRuntime) => {
    const patch = buildProviderVerificationPatch(result);
    params.setProbeResult(result);
    updateActiveProviderDraft({ ...patch, probe: { ...patch.probe, configurationSignature: result.id?.startsWith('credential-proof:') ? verificationIdentity : undefined } });
    updateDiagnosticsDraft({ providerStatus: patch.status });
  };

  const resetForTemplate = (template: ProviderTemplate) => {
    params.setProbeResult(null);
    params.setSmokeResult(null);
    setSecretDraft('');
    setSecretStatusMessage(null);
    setSecretVisible(false);
    const nextProvider = { ...activeProvider, ...buildProviderDraftPatchFromTemplate(activeProvider, template) };
    const signature = providersPageHelpers.buildModelCatalogSignature(nextProvider);
    setModelCatalog(providersPageHelpers.createFallbackModelCatalog(
      signature,
      template,
      template.defaultDraft.model,
      activeProvider.localModelCapabilityRegistry ?? [],
      template.defaultDraft.baseUrl,
    ));
  };

  const refreshModelCatalog = async () => {
    const revision = ++refreshRevision.current;
    if (params.providerRuntimeBlocked) {
      params.setModelCatalog(providersPageHelpers.createEmptyModelCatalog(
        params.modelCatalogSignature, 'error',
        blockedMessage(params.t('providers.actions.fetchModelList')),
      ));
      return false;
    }
    params.setModelCatalog((current) => ({ ...current, status: 'loading', error: null }));
    const provider = params.activeProvider;
    const isCurrent = () => refreshRevision.current === revision && mountedIdentity.current === verificationIdentity;
    const [catalogResult, metadataResult] = await Promise.allSettled([
      fetchProviderModels(provider, []),
      provider.kind === 'dashscope' ? fetchProviderModelMetadata(provider).then((result) => {
        if (result.error) throw new Error(result.error.message);
        if (result.providerId !== provider.providerId) throw new Error('Provider metadata response identity mismatch');
        return result;
      }) : Promise.resolve(null),
    ]);
    if (!isCurrent()) return false;
    const metadataError = metadataResult.status === 'rejected'
      ? providersPageHelpers.formatRuntimeErrorMessage(params.t('providers.messages.fetchModelCatalogFailed'), metadataResult.reason)
      : null;
    if (metadataResult.status === 'fulfilled' && metadataResult.value) {
      const result = metadataResult.value;
      updateActiveProviderDraft({ modelMetadataCache: {
        source: 'bailian-api', fetchedAt: result.fetchedAt, endpoint: result.endpoint, models: result.models,
      } });
    }
    if (catalogResult.status === 'rejected') {
      params.setModelCatalog((current) => ({ ...current, status: 'error', error: [
        providersPageHelpers.formatRuntimeErrorMessage(params.t('providers.messages.fetchModelCatalogFailed'), catalogResult.reason),
        metadataError,
      ].filter(Boolean).join('\n') }));
      return false;
    }
    const catalog = catalogResult.value;
    const models = normalizeProviderModels(catalog.models, params.localModelCapabilityRegistry);
    const catalogError = catalog.error?.message ?? (models.length === 0 ? params.t('providers.messages.emptyModelCatalog') : null);
    const error = [catalogError, metadataError].filter(Boolean).join('\n') || null;
    if (!catalogError) {
      const cache = providersPageHelpers.buildModelCatalogCache(
        params.modelCatalogSignature, 'runtime', models, catalog.endpoint, catalog.fetchedAt,
        null, provider.templateId, provider.displayName,
      );
      updateActiveProviderDraft({ modelCatalogCache: cache });
    }
    params.setModelCatalog({
      signature: params.modelCatalogSignature,
      status: error ? 'error' : 'ready', source: 'runtime', models,
      error, fetchedAt: catalog.fetchedAt, endpoint: catalog.endpoint,
    });
    return !error;
  };
  const handleSecretSave = async () => {
    if (!params.secretDraft.trim() && !params.activeProvider.baseUrl.trim()) return;
    if (params.providerRuntimeBlocked) {
      params.setSecretStatusMessage(blockedMessage(params.t('providers.actions.saveSecret')));
      return;
    }

    params.setBusyAction('secret');
    let finishCredentialChange: (() => void) | undefined;
    try {
      if (params.secretDraft.trim()) {
        finishCredentialChange = beginCredentialVerificationChange(params.activeProvider.authRef.reference);
        await saveProviderSecret(params.activeProvider.authRef.reference, params.secretDraft.trim());
        params.setSecretStored(true);
        params.setSecretDraft('');
        params.setSecretVisible(false);
      }
      params.setSecretStatusMessage(params.t('providers.messages.secretSaved'));
      const catalogRefreshed = await refreshModelCatalog();
      if (!catalogRefreshed) {
        params.setSecretStatusMessage(params.t('providers.messages.secretSavedCatalogUnknown', {
          defaultValue: 'API Key 已保存，但模型状态刷新失败；密钥无需重新填写，请稍后刷新模型列表。',
        }));
      }
    } catch (error) {
      params.setSecretStatusMessage(providersPageHelpers.formatRuntimeErrorMessage(
        params.t('providers.messages.secretWriteFailed'),
        error,
      ));
      if (verificationStillCurrent()) setVerificationStatus('warning');
    } finally {
      // A timeout does not prove the vault write did not happen.
      finishCredentialChange?.();
      params.setBusyAction(null);
    }
  };

  const handleSecretVisibilityToggle = async () => {
    if (params.secretVisible) {
      params.setSecretVisible(false);
      return;
    }
    if (params.providerRuntimeBlocked) {
      params.setSecretStatusMessage(blockedMessage(params.t('providers.actions.readSecret')));
      return;
    }
    if (params.secretDraft) {
      params.setSecretVisible(true);
      return;
    }

    params.setBusyAction('secret-reveal');
    try {
      const payload = await readProviderSecret(params.activeProvider.authRef.reference);
      if (!payload.secret) {
        params.setSecretStored(false);
        params.setSecretStatusMessage(params.t('providers.messages.noStoredSecret'));
        return;
      }
      params.setSecretDraft(payload.secret);
      params.setSecretStored(true);
      params.setSecretVisible(true);
      params.setSecretStatusMessage(params.t('providers.messages.secretPlainLoaded'));
    } catch (error) {
      params.setSecretVisible(false);
      params.setSecretStatusMessage(providersPageHelpers.formatRuntimeErrorMessage(
        params.t('providers.messages.secretPlainReadFailed'),
        error,
      ));
    } finally {
      params.setBusyAction(null);
    }
  };

  const handleVerificationRun = async () => {
    if (params.providerRuntimeBlocked) {
      params.setSecretStatusMessage(blockedMessage(params.t('providers.actions.verifyProvider')));
      return;
    }

    if (!verificationStillCurrent()) return;
    params.setBusyAction('verify');
    try {
      const probe = await runProviderProbe(params.activeProvider);
      if (!verificationStillCurrent()) return;
      syncProbeState(probe);
      if (probe.error) {
        params.setSmokeResult(null);
        params.setVerificationModalOpen(true);
        return;
      }

      const result = await runProviderSmoke(
        params.activeProvider,
        params.sampleText,
        params.sourceLanguage,
        params.targetLanguage,
      );
      if (!verificationStillCurrent()) return;
      params.setSmokeResult(result);
      setVerificationStatus(result.error || !result.streamObserved ? 'warning' : 'ready');
      params.setVerificationModalOpen(true);
    } catch (error) {
      if (!verificationStillCurrent()) return;
      params.setSecretStatusMessage(providersPageHelpers.formatRuntimeErrorMessage(
        params.t('providers.messages.verifyFailed'),
        error,
      ));
      if (verificationStillCurrent()) setVerificationStatus('warning');
    } finally {
      params.setBusyAction(null);
    }
  };

  return {
    handleSecretSave,
    handleSecretVisibilityToggle,
    handleVerificationRun,
    refreshModelCatalog: async () => { await refreshModelCatalog(); },
    resetForTemplate,
  };
}
