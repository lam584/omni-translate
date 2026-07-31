import { describe, expect, it } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';
import { defaultProviderTemplate, providerTemplates } from '../mocks/provider-templates';
import type { AudioRouteMode } from '../schema/config';
import type { ProviderCapability } from '../schema/provider-contract';
import { PENDING_PROBE_CHECKED_AT } from '../schema/provider-probe';
import { useAppStore } from '../stores/app-store';
import { buildProviderDraftPatchFromTemplate, mapProbeVerdictToConfigStatus } from '../utils/provider-draft';
import { providersPageHelpers as helpers } from './ProvidersPage';

const dashscopeTemplate = providerTemplates.find((template) => template.id === 'template-dashscope-realtime')!;
const deepseekTemplate = providerTemplates.find((template) => template.id === 'template-deepseek')!;

describe('ProvidersPage helpers', () => {
  it('formats labels, transports, scenarios, timestamps and errors', () => {
    expect(helpers.formatProviderLabel(' Example  API  Platform ')).toBe('Example Platform');
    expect(['streaming-http', 'websocket', 'http'].map(helpers.formatTransportLabel)).toEqual(['流式 HTTP', '长连接', '普通 HTTP']);
    expect(['watch', 'game', 'voice-room', 'subtitle-translate', 'custom'].map((scenario) => helpers.formatScenarioLabel(scenario as Parameters<typeof helpers.formatScenarioLabel>[0]))).toEqual([
      '语音转文字',
      '文字转语音',
      '语音转语音（语音翻译）',
      '字幕翻译',
      'custom',
    ]);
    expect(helpers.formatTimestampLabel(null)).toBeNull();
    expect(helpers.formatTimestampLabel('unix:invalid')).toBe('unix:invalid');
    expect(helpers.formatTimestampLabel('invalid')).toBe('invalid');
    expect(helpers.formatTimestampLabel('unix:1710000000')).not.toBe('unix:1710000000');
    expect(helpers.formatTimestampLabel('1710000000')).not.toBe('1710000000');
    expect(helpers.formatTimestampLabel('1710000000000')).not.toBe('1710000000000');
    expect(helpers.formatTimestampLabel('2026-06-01T00:00:00Z')).not.toBe('2026-06-01T00:00:00Z');
    expect(helpers.formatSmokeStatusLabel('completed')).toBe('完成');
    expect(helpers.formatSmokeStatusLabel('failed')).toBe('失败');
    expect(helpers.formatSubtitlePriorityLabel('subtitle-first')).toBe('字幕优先');
    expect(helpers.formatSubtitlePriorityLabel('balanced')).toBe('均衡');
    expect(helpers.formatRuntimeErrorMessage('失败', new Error('detail'))).toBe('失败：detail');
    expect(helpers.formatRuntimeErrorMessage('失败', 'detail')).toBe('失败：detail');
    expect(helpers.formatRuntimeErrorMessage('失败')).toBe('失败');
  });

  it('selects icons and provider defaults for every supported kind', () => {
    expect(['speech-to-speech', 'text-to-speech', 'text-generation', 'speech-to-text'].map((capability) => helpers.resolveCapabilityIconName(capability as ProviderCapability))).toEqual([
      'wave',
      'headphones',
      'spark',
      'mic',
    ]);
    expect(helpers.resolveTemplateIconName('dashscope')).toBe('layers');
    expect(helpers.resolveTemplateIconName('openai-compatible')).toBe('spark');
    expect(
      [
        ['speech-to-speech'],
        ['text-to-speech'],
        ['speech-to-text'],
        ['text-generation'],
        [],
      ].map((capabilities) => helpers.resolveModelIconName({ id: 'm', displayName: 'm', ownedBy: null, createdAt: null, capabilities: capabilities as ProviderCapability[] })),
    ).toEqual(['wave', 'headphones', 'mic', 'spark', 'spark']);
    expect(helpers.formatModelCatalogSourceLabel('runtime')).toBe('实时目录');
    expect(helpers.formatModelCatalogSourceLabel('preset')).toBe('预置回退');
    expect(helpers.defaultBaseUrlForKind('dashscope')).toContain('dashscope');
    expect(helpers.defaultBaseUrlForKind('openrouter')).toContain('openrouter');
    expect(helpers.defaultBaseUrlForKind('ollama')).toContain('11434');
    expect(helpers.defaultBaseUrlForKind('lmstudio')).toContain('1234');
    expect(helpers.defaultBaseUrlForKind('nvidia')).toContain('nvidia');
    expect(helpers.defaultBaseUrlForKind('openai-compatible')).toContain('openai');
    expect(helpers.defaultCompatibleDashscopeBaseUrl()).toContain('compatible-mode');
    expect(helpers.supportedTransportsForKind('dashscope')).toEqual(['http', 'websocket']);
    expect(helpers.supportedTransportsForKind('openrouter')).toEqual(['http', 'streaming-http']);
    expect(helpers.supportedTransportsForKind('ollama')).toEqual(['http', 'streaming-http']);
    expect(helpers.supportedTransportsForKind('lmstudio')).toEqual(['http', 'streaming-http']);
    expect(helpers.supportedTransportsForKind('nvidia')).toEqual(['http', 'streaming-http']);
    expect(helpers.supportedTransportsForKind('openai-compatible')).toEqual(['http', 'streaming-http']);
    expect(helpers.defaultTransportForKind('dashscope')).toBe('websocket');
    expect(helpers.defaultTransportForKind('openai-compatible')).toBe('streaming-http');
    expect(helpers.defaultPromptTemplateForKind('dashscope')).toBe('game-live-translation-cn');
    expect(helpers.defaultPromptTemplateForKind('openai-compatible')).toBe('video-realtime-cn');
    expect(helpers.createDefaultCustomProviderDraft('dashscope')).toMatchObject({ region: 'cn-beijing', transport: 'websocket' });
    expect(helpers.createDefaultCustomProviderDraft()).toMatchObject({ region: '', transport: 'streaming-http' });
  });

  it('normalizes DashScope origins and resolves API-format base URLs', () => {
    expect(helpers.resolveDashscopeOrigin('wss://dashscope.aliyuncs.com/api-ws/v1')).toBe('https://dashscope.aliyuncs.com');
    expect(helpers.resolveDashscopeOrigin('ws://dashscope-intl.aliyuncs.com/api-ws/v1')).toBe('http://dashscope-intl.aliyuncs.com');
    expect(helpers.resolveDashscopeOrigin('not a URL')).toBeNull();
    expect(helpers.resolveDashscopeOrigin('https://example.test/v1')).toBeNull();
    expect(helpers.resolveBaseUrlForApiFormat('dashscope', 'wss://dashscope.aliyuncs.com/api-ws/v1', deepseekTemplate)).toBe(
      'https://dashscope.aliyuncs.com/api/v1',
    );
    expect(helpers.resolveBaseUrlForApiFormat('openai-compatible', 'wss://dashscope.aliyuncs.com/api-ws/v1', dashscopeTemplate)).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    expect(helpers.resolveBaseUrlForApiFormat('dashscope', 'https://example.test/v1', deepseekTemplate)).toContain('dashscope.aliyuncs.com');
    expect(helpers.resolveBaseUrlForApiFormat('dashscope', 'https://example.test/v1', dashscopeTemplate)).toBe(dashscopeTemplate.defaultDraft.baseUrl);
    expect(helpers.resolveBaseUrlForApiFormat('openai-compatible', 'https://example.test/v1', deepseekTemplate)).toBe(
      deepseekTemplate.defaultDraft.baseUrl,
    );
    expect(helpers.resolveBaseUrlForApiFormat('openai-compatible', 'https://example.test/v1', dashscopeTemplate)).toContain('compatible-mode');
    expect(helpers.resolveBaseUrlForApiFormat('dashscope', 'https://example.test/v1', { ...deepseekTemplate, defaultDraft: { ...deepseekTemplate.defaultDraft, baseUrl: 'https://custom.test/v1' } })).toContain('dashscope.aliyuncs.com');
    expect(helpers.resolveBaseUrlForApiFormat('dashscope', '', deepseekTemplate)).toBe(helpers.defaultBaseUrlForKind('dashscope'));
    expect(helpers.resolveBaseUrlForApiFormat('openai-compatible', 'https://example.test/v1', { ...dashscopeTemplate, defaultDraft: { ...dashscopeTemplate.defaultDraft, baseUrl: 'https://custom.test/v1' } })).toBe(helpers.defaultCompatibleDashscopeBaseUrl());
    expect(helpers.normalizeBaseUrlForComparison(' https://example.test/v1/// ')).toBe('https://example.test/v1');
    expect(helpers.shouldUseTemplatePresetModels(deepseekTemplate, `${deepseekTemplate.defaultDraft.baseUrl}/`)).toBe(true);
  });

  it('maps drafts, fallback models and model catalog cache entries', () => {
    const provider = structuredClone(appConfigDraftMock.providers[0]);
    provider.region = undefined;
    expect(helpers.providerDraftToCustomProviderTemplateDraft(provider).region).toBe('');
    expect(helpers.buildModelCatalogSignature(provider)).toContain(provider.templateId);

    const preset = helpers.presetToRuntimeModel(deepseekTemplate.presetModels[0]);
    expect(preset.ownedBy).toBe('preset');
    expect(helpers.createDerivedRuntimeModel(' custom-model ', [], 'manual')).toMatchObject({ id: 'custom-model', ownedBy: 'manual' });
    expect(helpers.buildFallbackModels(deepseekTemplate, ' custom-model ', [], deepseekTemplate.defaultDraft.baseUrl)[0]?.id).toBe('custom-model');
    expect(helpers.buildFallbackModels(deepseekTemplate, deepseekTemplate.defaultDraft.model, [], 'https://custom.example/v1')).toEqual([]);
    expect(helpers.dedupeModels([preset, preset])).toHaveLength(1);

    const cacheItem = helpers.runtimeModelToCacheItem({ ...preset, ownedBy: null, createdAt: null });
    expect(cacheItem).toMatchObject({ ownedBy: null, createdAt: null, providerTemplateId: '', providerTemplateName: '' });
    expect(helpers.cacheItemToRuntimeModel(cacheItem)).toMatchObject({ id: preset.id });
    expect(helpers.createEmptyModelCatalogCache()).toMatchObject({ source: 'preset', models: [] });
    expect(helpers.createFallbackModelCatalog('sig', deepseekTemplate, 'custom-model', [], deepseekTemplate.defaultDraft.baseUrl)).toMatchObject({
      signature: 'sig',
      source: 'preset',
    });
    expect(helpers.createEmptyModelCatalog('sig', 'error', 'broken')).toMatchObject({ status: 'error', error: 'broken' });
  });

  it('detects and restores cached catalogs and fills missing scene assignments', () => {
    const provider = structuredClone(appConfigDraftMock.providers[0]);
    const signature = helpers.buildModelCatalogSignature(provider);
    const model = { id: 'runtime-model', displayName: 'Runtime Model', ownedBy: null, createdAt: null, capabilities: ['text-generation'] as ProviderCapability[] };
    const cache = helpers.buildModelCatalogCache(signature, 'runtime', [model], '/models', 'unix:1710000000', null, provider.templateId, provider.displayName);
    expect(helpers.hasCachedModelCatalog(cache, signature)).toBe(true);
    expect(helpers.hasCachedModelCatalog({ ...cache, signature: 'different' }, signature)).toBe(false);
    expect(helpers.hasCachedModelCatalog({ ...cache, models: [], fetchedAt: null, error: null }, signature)).toBe(false);
    expect(helpers.hasCachedModelCatalog({ ...cache, models: [], fetchedAt: null, error: 'broken' }, signature)).toBe(true);
    expect(helpers.buildModelCatalogStateFromCache(signature, { ...cache, error: 'broken' }, dashscopeTemplate, provider.model, [], provider.baseUrl)).toMatchObject({
      status: 'error',
      source: 'runtime',
      error: 'broken',
    });
    expect(helpers.ensureSceneAssignments([{ scenario: 'watch', modelIds: ['m'] }])).toEqual([
      { scenario: 'watch', modelIds: ['m'] },
      { scenario: 'game', modelIds: [] },
      { scenario: 'voice-room', modelIds: [] },
      { scenario: 'subtitle-translate', modelIds: [] },
    ]);
    expect(helpers.createCustomHeaderDraft()).toMatchObject({ name: '', value: '', enabled: true });
  });

  it('falls back to the first provider when the active provider id is missing', () => {
    const configDraft = structuredClone(appConfigDraftMock);
    configDraft.activeProviderTemplateId = 'missing-template';
    useAppStore.setState((state) => ({ ...state, configDraft }));
    expect(helpers.getActiveProviderFromState()).toBe(configDraft.providers[0]);
  });

  it('reorders provider templates and ignores invalid reorder requests', () => {
    const entries = providerTemplates.slice(0, 3).map((template, index) => ({ template, enabled: true, hidden: false, order: index }));
    expect(helpers.reorderTemplateEntries(entries, '', entries[1].template.id)).toBe(entries);
    expect(helpers.reorderTemplateEntries(entries, entries[0].template.id, entries[0].template.id)).toBe(entries);
    expect(helpers.reorderTemplateEntries(entries, 'missing', entries[1].template.id)).toBe(entries);
    expect(helpers.reorderTemplateEntries(entries, entries[0].template.id, 'missing')).toBe(entries);
    expect(helpers.reorderTemplateEntries(entries, entries[0].template.id, entries[2].template.id).map((entry) => entry.template.id)).toEqual([
      entries[1].template.id,
      entries[2].template.id,
      entries[0].template.id,
    ]);
  });

  it('adds, removes and reorders scene models with stable defaults', () => {
    const assignments = helpers.ensureSceneAssignments([{ scenario: 'watch', modelIds: ['model-a', 'model-b'] }]);
    expect(helpers.addSceneModel(assignments, 'watch', 'model-a')).toEqual(assignments);
    expect(helpers.addSceneModel(assignments, 'game', 'model-c').find((item) => item.scenario === 'game')?.modelIds).toEqual(['model-c']);
    expect(helpers.addSceneModelToAll(assignments, 'model-a').every((item) => item.modelIds.includes('model-a'))).toBe(true);

    expect(helpers.removeSceneModel(assignments, 'watch', 'model-a', 'watch', 'model-a', 'default-model')).toMatchObject({
      nextModel: 'model-b',
    });
    expect(helpers.removeSceneModel(assignments, 'watch', 'model-b', 'watch', 'model-b', 'default-model')).toMatchObject({
      nextModel: 'model-a',
    });
    expect(helpers.removeSceneModel(assignments, 'game', 'model-a', 'watch', 'model-a', 'default-model').nextModel).toBeUndefined();
    expect(helpers.removeSceneModel(assignments, 'game', 'model-a', 'watch', 'model-b', 'default-model').nextModel).toBeUndefined();
    expect(helpers.removeSceneModel(assignments, 'missing' as unknown as AudioRouteMode, 'model-a', 'missing' as unknown as AudioRouteMode, 'model-a', 'default-model').nextModel).toBe('default-model');
    expect(helpers.removeSceneModelFromAll(assignments, 'model-a', 'watch', 'model-a', 'default-model')).toMatchObject({
      nextModel: 'model-b',
    });
    expect(helpers.removeSceneModelFromAll(assignments, 'model-a', 'watch', 'model-c', 'default-model')).toMatchObject({
      nextModel: undefined,
    });
    expect(helpers.removeSceneModelFromAll(assignments, 'model-a', 'missing' as unknown as AudioRouteMode, 'model-a', 'default-model')).toMatchObject({
      nextModel: 'default-model',
    });
  });

  it('toggles response modalities and reorders scene model ids defensively', () => {
    const assignments = helpers.ensureSceneAssignments([{ scenario: 'watch', modelIds: ['model-a', 'model-b'] }]);
    expect(helpers.toggleResponseModalities(['text'], 'text')).toEqual(['text']);
    expect(helpers.toggleResponseModalities(['text'], 'audio')).toEqual(['text', 'audio']);
    expect(helpers.reorderSceneModels(assignments, null, 'watch', 'model-b')).toBe(assignments);
    expect(helpers.reorderSceneModels(assignments, { scenario: 'game', modelId: 'model-a' }, 'watch', 'model-b')).toBe(assignments);
    expect(helpers.reorderSceneModels(assignments, { scenario: 'watch', modelId: 'model-a' }, 'watch', 'model-a')).toBe(assignments);
    expect(helpers.reorderSceneModels(assignments, { scenario: 'watch', modelId: 'missing' }, 'watch', 'model-b')).toEqual(assignments);
    expect(
      helpers.reorderSceneModels(assignments, { scenario: 'watch', modelId: 'model-a' }, 'watch', 'model-b')
        .find((item) => item.scenario === 'watch')?.modelIds,
    ).toEqual(['model-b', 'model-a']);
  });

  describe('provider draft status mapping', () => {
    it('marks unavailable probes unsupported and keeps other verdicts ready', () => {
      expect(mapProbeVerdictToConfigStatus('unavailable')).toBe('unsupported');
      expect(mapProbeVerdictToConfigStatus('available')).toBe('ready');
      expect(mapProbeVerdictToConfigStatus('realtime-risk')).toBe('ready');
    });

    it('persists the stable non-localized pending sentinel in probe.checkedAt', () => {
      const patch = buildProviderDraftPatchFromTemplate(structuredClone(appConfigDraftMock.providers[0]), defaultProviderTemplate);

      expect(patch.probe?.checkedAt).toBe(PENDING_PROBE_CHECKED_AT);
      expect(patch.probe?.profileId.endsWith('-pending')).toBe(true);
    });
  });
});
