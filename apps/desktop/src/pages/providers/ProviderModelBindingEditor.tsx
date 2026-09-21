import ProviderWorkspaceEndpointHint from './ProviderWorkspaceEndpointHint';
import { hasCredentialBoundVerification } from '../../utils/provider-draft-verification';
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import type { ProviderDraft } from '../../schema/config';
import { PROVIDER_MANIFEST_REGISTRY } from '../../provider-manifest/bundle';
import { resolveProviderProtocol } from '../../provider-manifest/resolver';
import type { ProviderManifestOperation } from '../../provider-manifest/types';
import { useAppStore } from '../../stores/app-store';

/** Local configuration only: selecting a binding never sends a provider request. */
export default function ProviderModelBindingEditor({ provider }: { provider: ProviderDraft }) {
  const { t } = useTranslation();
  const [modelId, setModelId] = useState(provider.model);
  const update = useAppStore((state) => state.updateActiveProviderDraft);
  const manifest = PROVIDER_MANIFEST_REGISTRY.findByTemplateId(provider.templateId);
  if (!manifest) return null;
  const verifiedConfiguration = modelId === provider.model && hasCredentialBoundVerification(provider);
  const known = manifest.models.find((model) => model.id === modelId);
  const options = manifest.protocolProfiles.filter((profile) => profile.adapter.status === 'enabled')
    .flatMap((profile) => profile.operations.map((operation) => ({ profile, operation, key: JSON.stringify([profile.id, profile.version, operation]) })));
  const bindings = (provider.modelProtocolBindings ?? []).filter((binding) => binding.modelId === modelId);
  const declarations = known?.protocolBindings.map((binding) => ({
    modelId, operation: binding.operation, profileId: binding.protocolProfileId, profileVersion: binding.protocolProfileVersion,
    manifestVersion: manifest.manifestVersion, profileOwnerProviderId: manifest.provider.id,
  })) ?? bindings;
  const results = declarations.map((binding) => {
    try {
      const authority = resolveProviderProtocol([...PROVIDER_MANIFEST_REGISTRY.all()], {
        providerId: provider.providerId, templateId: provider.templateId, modelId,
        modelRegistryVersion: provider.modelRegistryVersion,
        operation: binding.operation as ProviderManifestOperation, declaredProfileId: binding.profileId,
        declaredProfileVersion: binding.profileVersion, declaredManifestVersion: binding.manifestVersion,
        baseUrl: provider.baseUrl, transport: provider.transport, region: provider.region, deploymentId: provider.deploymentId,
      });
      return `${binding.operation}: ${authority.protocolProfile.id}@${authority.protocolProfile.version}`;
    } catch (error) { return `${binding.operation}: ${t('providerProbe.verdictUnavailable')} · ${error instanceof Error ? error.message : String(error)}`; }
  });
  return <article className="content-card page-card compact-card provider-panel-card">
    <h3>{t('providers.capabilityRegistry.title')} / {t('customProvider.groupRouting')}</h3>
    <label>{t('providers.capabilityRegistry.modelIdLabel')}<input className="text-input" value={modelId} onChange={(event) => setModelId(event.target.value)} /></label>
    <p>{t('audioRouting.chainSource')}: {known ? t('providers.labels.presetFallback') + ' · ' + t('settings.overlayLockedState') : t('providers.modelCatalog.manualAdd') + ' · ' + (verifiedConfiguration ? t('providerProbe.verdictAvailable') : t('sceneReadiness.providerNotVerified'))}</p>
    {!known && <label>{t('customProvider.groupRouting')}<select aria-label={t('customProvider.groupRouting')} className="select-input" value="" onChange={(event) => {
      const selected = options.find((option) => option.key === event.target.value);
      if (!selected || !modelId || modelId !== modelId.trim()) return;
      const binding = { modelId, operation: selected.operation, profileOwnerProviderId: manifest.provider.id, manifestVersion: manifest.manifestVersion,
        profileId: selected.profile.id, profileVersion: selected.profile.version };
      update({ modelRegistryVersion: 2, modelProtocolBindings: [...(provider.modelProtocolBindings ?? []).filter((existing) => existing.modelId !== modelId || existing.operation !== binding.operation), binding] });
    }}><option value="">{t('customProvider.groupRoutingDesc')} · {t('providers.common.enabled')}</option>{options.map((option) => <option key={option.key} value={option.key}>{option.profile.id}@{option.profile.version} · {option.operation}</option>)}</select></label>}
    <ProviderWorkspaceEndpointHint provider={provider} modelId={modelId} />
    {results.length ? results.map((result, index) => <p key={index}>{t('customProvider.fieldTransport')}: {result}</p>) : <p>{t('providerProbe.verdictUnavailable')} · {t('sceneReadiness.providerNotVerified')}</p>}
  </article>;
}
