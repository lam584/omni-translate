import type { ConfigStatus, ProviderDraft, ProviderSceneModelAssignment } from '../schema/config';
import { PENDING_PROBE_CHECKED_AT } from '../schema/provider-probe';
import type { ProviderProbeProfileRuntime } from '../schema/provider-runtime';
import type { ProviderTemplate } from '../schema/provider-template';
import { createDefaultLocalModelCapabilityRegistry } from './provider-model-capabilities';
import { protocolBindingsForTemplate } from '../provider-manifest/template-projection';

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

  if (template.id === 'template-openai-compatible-realtime') {
    return [
      { scenario: 'watch', modelIds: ['gpt-realtime-translate', 'gpt-realtime-2.1'] },
      { scenario: 'game', modelIds: ['gpt-realtime-2.1-mini'] },
      { scenario: 'voice-room', modelIds: [] },
      { scenario: 'subtitle-translate', modelIds: [] },
    ];
  }

  if (template.id === 'template-dashscope-realtime') {
    return [
      { scenario: 'watch', modelIds: ['qwen3.5-livetranslate-flash-realtime'] },
      { scenario: 'game', modelIds: ['qwen3.5-livetranslate-flash-realtime'] },
      { scenario: 'voice-room', modelIds: ['qwen3.5-livetranslate-flash-realtime'] },
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

  if (template.id === 'template-zhipu-glm') {
    return [
      { scenario: 'watch', modelIds: ['glm-realtime-flash'] },
      { scenario: 'game', modelIds: ['glm-realtime-flash'] },
      { scenario: 'voice-room', modelIds: [] },
      { scenario: 'subtitle-translate', modelIds: [] },
    ];
  }

  if (template.id === 'template-tencent-speech') {
    return [
      { scenario: 'watch', modelIds: ['hunyuan-translation-lite'] },
      { scenario: 'game', modelIds: [] },
      { scenario: 'voice-room', modelIds: [] },
      { scenario: 'subtitle-translate', modelIds: [] },
    ];
  }

  if (template.id === 'template-azure-openai') {
    return [
      { scenario: 'watch', modelIds: ['gpt-realtime'] },
      { scenario: 'game', modelIds: [] },
      { scenario: 'voice-room', modelIds: [] },
      { scenario: 'subtitle-translate', modelIds: [] },
    ];
  }

  if (template.id === 'template-gemini') {
    return [
      { scenario: 'watch', modelIds: ['gemini-3.1-flash-live-preview'] },
      { scenario: 'game', modelIds: [] },
      { scenario: 'voice-room', modelIds: [] },
      { scenario: 'subtitle-translate', modelIds: [] },
    ];
  }

  return empty;
}

export function buildProviderDraftPatchFromTemplate(
  provider: ProviderDraft,
  template: ProviderTemplate,
): Partial<ProviderDraft> {
  const declaredModels = new Set(template.presetModels.map((preset) => preset.model));
  const manifestAlignedAssignments = buildDefaultSceneModelAssignments(template).map((assignment) => ({
    ...assignment,
    modelIds: assignment.modelIds.filter((modelId) => declaredModels.has(modelId)),
  }));
  if (template.manifestProviderId) {
    const watch = manifestAlignedAssignments.find((assignment) => assignment.scenario === 'watch');
    if (watch && watch.modelIds.length === 0) {
      const watchPreset = template.presetModels.find((preset) => (
        preset.capabilities.includes('speech-to-text')
        || preset.capabilities.includes('speech-to-speech')
      ));
      if (watchPreset) watch.modelIds = [watchPreset.model];
    }
    const subtitle = manifestAlignedAssignments.find((assignment) => assignment.scenario === 'subtitle-translate');
    if (subtitle && subtitle.modelIds.length === 0) {
      const textPreset = template.presetModels.find((preset) => preset.capabilities.includes('text-generation'));
      if (textPreset) subtitle.modelIds = [textPreset.model];
    }
  }
  return {
    templateId: template.id,
    templateVersion: template.version,
    templateSource: template.source,
    providerId: template.defaultDraft.providerId,
    manifestProviderId: template.manifestProviderId ?? template.defaultDraft.manifestProviderId,
    displayName: template.defaultDraft.displayName,
    kind: template.defaultDraft.kind,
    model: template.defaultDraft.model,
    deploymentId: template.defaultDraft.deploymentId,
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
    sceneModelAssignments: manifestAlignedAssignments,
    modelProtocolBindings: template.source === 'custom'
      ? template.defaultDraft.modelProtocolBindings ?? []
      : protocolBindingsForTemplate(template.id),
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
      checkedAt: PENDING_PROBE_CHECKED_AT,
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
