import { useTranslation } from 'react-i18next';
import type { ProviderDraft } from '../../schema/config';
import { MODEL_PROTOCOL_REGISTRY } from '../../model-protocol/profile-registry';
import { PROVIDER_MANIFEST_REGISTRY } from '../../provider-manifest/bundle';

/** Display only: never rewrite the user's endpoint or infer a WorkspaceId. */
export default function ProviderWorkspaceEndpointHint({ provider, modelId = provider.model }: { provider: ProviderDraft; modelId?: string }) {
  const { t } = useTranslation();
  const manifest = PROVIDER_MANIFEST_REGISTRY.findByTemplateId(provider.templateId);
  if (manifest?.provider.id !== 'bailian') return null;
  const known = manifest.models.find((model) => model.id === modelId);
  const profileIds = known
    ? known.protocolBindings.map((binding) => binding.protocolProfileId)
    : (provider.modelProtocolBindings ?? []).filter((binding) => binding.modelId === modelId
      && binding.profileOwnerProviderId === manifest.provider.id && binding.manifestVersion === manifest.manifestVersion)
      .map((binding) => binding.profileId);
  const profile = MODEL_PROTOCOL_REGISTRY.profiles.find((candidate) => profileIds.includes(candidate.profileId)
    && candidate.endpointRequirements?.workspaceScoped);
  if (!profile) return null;
  const region = provider.region || manifest.provider.defaultRegion;
  const host = MODEL_PROTOCOL_REGISTRY.endpointHostPolicies.find((policy) => policy.region === region)
    ?.allowedHostFamilies.find((family) => family.workspaceScoped)?.hostPattern.replace('*', '{WorkspaceId}');
  const dialect = MODEL_PROTOCOL_REGISTRY.dialects.find((candidate) => candidate.dialectId === profile.dialectId);
  const endpoint = host && dialect ? `wss://${host}${dialect.endpointPath}` : '';
  return <p className="provider-setting-footnote" data-testid="workspace-endpoint-hint">
    {t('providers.auth.workspaceEndpointRequired')}{endpoint && <> <code>{endpoint}</code></>}
  </p>;
}
