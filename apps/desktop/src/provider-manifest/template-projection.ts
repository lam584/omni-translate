import type { ProviderCapability } from '../schema/provider-contract';
import type { ModelPreset, ProviderTemplate } from '../schema/provider-template';
import type { ProviderModelProtocolBinding } from '../schema/config';

import { PROVIDER_MANIFEST_REGISTRY } from './bundle';
import type { ProviderManifest, ProviderManifestModel } from './types';

function uiCapabilities(model: ProviderManifestModel): ProviderCapability[] {
  const capabilities = new Set<ProviderCapability>();
  for (const capability of model.capabilities) {
    if (capability === 'text-generation' || capability === 'text-translation') {
      capabilities.add('text-generation');
    }
    if (
      capability === 'speech-to-text'
      || capability === 'realtime-transcription'
      || capability === 'file-transcription'
      || capability === 'speech-translation'
    ) {
      capabilities.add('speech-to-text');
    }
    if (capability === 'text-to-speech') capabilities.add('text-to-speech');
    if (capability === 'speech-to-speech') capabilities.add('speech-to-speech');
  }
  return [...capabilities];
}

function enabledBindings(manifest: ProviderManifest, model: ProviderManifestModel) {
  return model.protocolBindings.filter((binding) => manifest.protocolProfiles.some((profile) => (
    profile.id === binding.protocolProfileId
    && profile.version === binding.protocolProfileVersion
    && profile.adapter.status === 'enabled'
  )));
}

function bindings(manifest: ProviderManifest): ProviderModelProtocolBinding[] {
  return manifest.models.flatMap((model) => model.protocolBindings.map((binding) => ({
    modelId: model.id,
    operation: binding.operation,
    profileOwnerProviderId: manifest.provider.id,
    manifestVersion: manifest.manifestVersion,
    profileId: binding.protocolProfileId,
    profileVersion: binding.protocolProfileVersion,
  })));
}

function presetForModel(
  template: ProviderTemplate,
  manifest: ProviderManifest,
  model: ProviderManifestModel,
): ModelPreset {
  const existing = template.presetModels.find((preset) => preset.model === model.id);
  const verification = enabledBindings(manifest, model)
    .map((binding) => manifest.protocolProfiles.find((profile) => (
    profile.id === binding.protocolProfileId && profile.version === binding.protocolProfileVersion
  ))?.adapter.verification);
  const fixtureOnlyCount = verification.filter((status) => status === 'fixture-only').length;
  const verificationNote = fixtureOnlyCount > 0
    ? `【fixture-only ${fixtureOnlyCount}/${verification.length}；对应操作未保留 live provider 证据】`
    : '';
  return {
    id: existing?.id ?? `${template.id.replace(/^template-/, '')}-${model.id}`,
    model: model.id,
    displayName: existing?.displayName ?? model.displayName,
    capabilities: uiCapabilities(model),
    description: [
      existing?.description ?? model.availability ?? `${model.displayName}（由 Provider Manifest 管理）`,
      verificationNote,
    ].filter(Boolean).join(' '),
  };
}

/**
 * Projects an official UI template from the same compiled manifest consumed
 * by runtime authorization. Disabled or manifest-only adapters stay visible
 * in the module but cannot appear as actionable UI presets.
 */
export function projectTemplateFromProviderManifest(template: ProviderTemplate): ProviderTemplate {
  const manifest = PROVIDER_MANIFEST_REGISTRY.findByTemplateId(template.id);
  if (!manifest) return template;

  const enabledModels = manifest.models.filter((model) => enabledBindings(manifest, model).length > 0);
  const declaredDefault = enabledModels.find((model) => model.id === manifest.provider.defaultModelId);
  const defaultModel = declaredDefault ?? enabledModels[0];
  const defaultBinding = defaultModel ? enabledBindings(manifest, defaultModel)[0] : undefined;
  const defaultProfile = defaultBinding
    ? manifest.protocolProfiles.find((profile) => (
      profile.id === defaultBinding.protocolProfileId
      && profile.version === defaultBinding.protocolProfileVersion
    ))
    : undefined;
  const defaultFamily = defaultProfile
    ? manifest.apiFamilies.find((family) => family.id === defaultProfile.apiFamilyId)
    : undefined;
  const defaultAuth = defaultProfile
    ? manifest.authProfiles.find((auth) => auth.id === defaultProfile.defaultAuthProfileId)
    : undefined;
  const credentialHeader = defaultAuth?.parameters.find((parameter) => (
    parameter.location === 'header'
    && parameter.source === 'credential'
    && parameter.required
  ));
  const authScheme = credentialHeader
    ? (credentialHeader.scheme?.toLowerCase() === 'bearer' || defaultAuth?.type === 'bearer'
      ? 'bearer' as const
      : 'api-key' as const)
    : template.defaultDraft.auth.scheme;
  const projectedTransport = defaultProfile
    ? manifest.transports.find((transport) => transport.id === defaultProfile.transportId)?.kind
    : undefined;
  const providerTransport = projectedTransport === 'sse'
    ? 'streaming-http' as const
    : projectedTransport === 'websocket' || projectedTransport === 'http'
      ? projectedTransport
      : template.defaultDraft.transport;
  const projectedBaseUrl = defaultFamily && !defaultFamily.baseUrlTemplate.includes('{')
    ? defaultFamily.baseUrlTemplate.replace(/^wss:/, 'https:')
    : template.defaultDraft.baseUrl;
  const requiresDeployment = defaultFamily?.modelAddressing === 'deployment-id'
    || defaultFamily?.modelAddressing === 'path-deployment';
  const deploymentField = requiresDeployment && !template.fieldGroups.some((group) => (
    group.fields.some((field) => field.key === 'deploymentId')
  ))
    ? [{
      id: `${template.id}-deployment-id`,
      key: 'deploymentId' as const,
      label: 'Deployment ID',
      description: 'Azure 资源中的不透明部署名；它与目录模型 ID 分开保存。',
    }]
    : [];

  return {
    ...template,
    manifestProviderId: manifest.provider.id,
    defaultDraft: {
      ...template.defaultDraft,
      manifestProviderId: manifest.provider.id,
      model: defaultModel?.id ?? template.defaultDraft.model,
      baseUrl: projectedBaseUrl,
      deploymentId: requiresDeployment ? '' : undefined,
      transport: providerTransport,
      auth: {
        ...template.defaultDraft.auth,
        headerName: credentialHeader?.name ?? template.defaultDraft.auth.headerName,
        scheme: authScheme,
      },
    },
    fieldGroups: template.fieldGroups.map((group, index) => index === 0 && deploymentField.length > 0
      ? { ...group, fields: [...group.fields, ...deploymentField] }
      : group),
    presetModels: enabledModels.map((model) => presetForModel(template, manifest, model)),
  };
}

export function protocolBindingsForTemplate(templateId: string): ProviderModelProtocolBinding[] {
  const manifest = PROVIDER_MANIFEST_REGISTRY.findByTemplateId(templateId);
  return manifest ? bindings(manifest) : [];
}
