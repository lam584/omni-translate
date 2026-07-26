import i18n from '../i18n/config';
import type { ConfigStatus, ProviderDraft, ProviderSceneModelAssignment } from '../schema/config';
import type { ProviderProbeProfileRuntime } from '../schema/provider-runtime';
import type { ProviderTemplate } from '../schema/provider-template';
import { createDefaultLocalModelCapabilityRegistry } from './provider-model-capabilities';

export function mapProbeVerdictToConfigStatus(verdict: 'available' | 'realtime-risk' | 'unavailable'): ConfigStatus {
  if (verdict === 'unavailable') {
    return 'unsupported';
  }

  return 'ready';
}

export function buildDefaultSceneModelAssignments(template: ProviderTemplate): ProviderSceneModelAssignment[] {
  const empty: ProviderSceneModelAssignment[] = [
    { scenario: 'watch', modelIds: [] },
    { scenario: 'game', modelIds: [] },
    { scenario: 'voice-room', modelIds: [] },
    { scenario: 'subtitle-translate', modelIds: [] },
  ];

  if (template.id === 'template-dashscope-realtime') {
    return [
      { scenario: 'watch', modelIds: ['qwen3.5-omni-plus-realtime'] },
      { scenario: 'game', modelIds: ['qwen3.5-omni-plus-realtime'] },
      { scenario: 'voice-room', modelIds: ['qwen3.5-omni-plus-realtime'] },
      { scenario: 'subtitle-translate', modelIds: ['qwen3.6-flash'] },
    ];
  }

  if (template.id === 'template-deepseek') {
    return [
      { scenario: 'watch', modelIds: [] },
      { scenario: 'game', modelIds: [] },
      { scenario: 'voice-room', modelIds: [] },
      { scenario: 'subtitle-translate', modelIds: ['deepseek-v4-flash'] },
    ];
  }

  if (template.id === 'template-openrouter') {
    return [
      { scenario: 'watch', modelIds: [] },
      { scenario: 'game', modelIds: [] },
      { scenario: 'voice-room', modelIds: [] },
      { scenario: 'subtitle-translate', modelIds: ['openai/gpt-5.4-mini'] },
    ];
  }

  return empty;
}

export function buildProviderDraftPatchFromTemplate(
  provider: ProviderDraft,
  template: ProviderTemplate,
): Partial<ProviderDraft> {
  return {
    templateId: template.id,
    templateVersion: template.version,
    templateSource: template.source,
    providerId: template.defaultDraft.providerId,
    displayName: template.defaultDraft.displayName,
    kind: template.defaultDraft.kind,
    model: template.defaultDraft.model,
    baseUrl: template.defaultDraft.baseUrl,
    transport: template.defaultDraft.transport,
    authRef: {
      ...provider.authRef,
      headerName: template.defaultDraft.auth.headerName,
      reference: template.defaultDraft.auth.reference,
      scheme: template.defaultDraft.auth.scheme,
    },
    region: template.defaultDraft.region,
    streamEnabled: template.defaultDraft.streamEnabled,
    timeoutMs: template.defaultDraft.timeoutMs,
    systemPromptTemplate: template.defaultDraft.systemPromptTemplate,
    temperature: 0.2,
    maxOutputTokens: 256,
    responseModalities: ['text'],
    customHeaders: [],
    sceneModelAssignments: buildDefaultSceneModelAssignments(template),
    localModelCapabilityRegistry: createDefaultLocalModelCapabilityRegistry(),
    modelCatalogCache: {
      signature: '',
      source: 'preset',
      endpoint: null,
      fetchedAt: null,
      error: null,
      models: [],
    },
    probe: {
      profileId: `probe-${template.defaultDraft.providerId}-pending`,
      verdict: 'realtime-risk',
      checkedAt: i18n.t('providerProbe.pendingProbe'),
      streamSupported: template.defaultDraft.streamEnabled,
      errorShapeStable: false,
      responseShapeStable: false,
    },
    mode: 'template',
    status: 'draft',
  };
}

export function buildProviderVerificationPatch(result: ProviderProbeProfileRuntime): Pick<ProviderDraft, 'probe' | 'status'> {
  return {
    probe: {
      profileId: result.id,
      verdict: result.verdict,
      checkedAt: result.checkedAt,
      streamSupported: result.streamSupported,
      errorShapeStable: result.errorShapeStable,
      responseShapeStable: result.responseShapeStable,
    },
    status: mapProbeVerdictToConfigStatus(result.verdict),
  };
}
