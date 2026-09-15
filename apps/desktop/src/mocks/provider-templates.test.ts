import { describe, expect, it, vi } from 'vitest';

import { defaultProviderTemplate, providerTemplates } from './provider-templates';
import {
  buildProviderTemplateCatalogEntries,
  persistProviderTemplateCatalogEntries,
  PROVIDER_TEMPLATE_CATALOG_UPDATED_EVENT,
  readProviderTemplateCatalogPreferences,
  writeProviderTemplateCatalogPreferences,
} from '../utils/provider-template-catalog';
import { buildDefaultSceneModelAssignments } from '../utils/provider-draft';

describe('default provider template', () => {
  it('uses Aliyun Bailian realtime as the desktop default', () => {
    expect(defaultProviderTemplate.id).toBe('template-dashscope-realtime');
    expect(defaultProviderTemplate.displayName).toContain('API');
    expect(defaultProviderTemplate.realtimeProtocol).toBeUndefined();
    expect(defaultProviderTemplate.defaultDraft.model).toBe('qwen3.5-livetranslate-flash-realtime');
  });

  it('keeps text-only DashScope presets out of speech scenarios', () => {
    const dashscope = providerTemplates.find((template) => template.id === 'template-dashscope-realtime');
    for (const modelId of ['qwen-plus', 'qwen-max', 'qwen-turbo']) {
      expect(dashscope?.presetModels.find((model) => model.model === modelId)?.capabilities).toEqual([
        'text-generation',
      ]);
    }
  });

  it('includes common provider presets in the platform catalog', () => {
    expect(providerTemplates.map((template) => template.id)).toEqual(
      expect.arrayContaining([
        'template-openrouter',
        'template-deepseek',
        'template-nvidia',
        'template-gemini',
        'template-ollama',
        'template-lmstudio',
        'template-zhipu-glm',
        'template-tencent-speech',
        'template-azure-openai',
      ]),
    );
  });

  it('marks every actionable fixture-only manifest model in the UI', () => {
    for (const templateId of [
      'template-openai-compatible-realtime',
      'template-gemini',
      'template-zhipu-glm',
      'template-tencent-speech',
      'template-azure-openai',
    ]) {
      const template = providerTemplates.find((candidate) => candidate.id === templateId);
      expect(template?.presetModels.length).toBeGreaterThan(0);
      expect(template?.presetModels.every((model) => model.description.includes('fixture-only'))).toBe(true);
    }
  });

  it('enables only Aliyun Bailian and DeepSeek by default', () => {
    const entries = buildProviderTemplateCatalogEntries(providerTemplates, []);
    const enabledTemplateIds = entries.filter((entry) => entry.enabled).map((entry) => entry.template.id);

    expect(enabledTemplateIds).toEqual([
      'template-dashscope-realtime',
      'template-deepseek',
    ]);
  });

  it('uses provider-specific default scene models', () => {
    const openai = providerTemplates.find((template) => template.id === 'template-openai-compatible-realtime');
    const dashscope = providerTemplates.find((template) => template.id === 'template-dashscope-realtime');
    const deepseek = providerTemplates.find((template) => template.id === 'template-deepseek');
    const openrouter = providerTemplates.find((template) => template.id === 'template-openrouter');
    const ollama = providerTemplates.find((template) => template.id === 'template-ollama');

    expect(buildDefaultSceneModelAssignments(openai!).map((item) => [item.scenario, item.modelIds])).toEqual([
      ['watch', ['gpt-realtime-translate', 'gpt-realtime-2.1']],
      ['game', ['gpt-realtime-2.1-mini']],
      ['voice-room', []],
      ['subtitle-translate', []],
    ]);
    expect(buildDefaultSceneModelAssignments(dashscope!).map((item) => [item.scenario, item.modelIds])).toEqual([
      ['watch', ['qwen3.5-livetranslate-flash-realtime']],
      ['game', ['qwen3.5-livetranslate-flash-realtime']],
      ['voice-room', ['qwen3.5-livetranslate-flash-realtime']],
      ['subtitle-translate', ['qwen3.6-flash']],
    ]);
    expect(buildDefaultSceneModelAssignments(deepseek!).find((item) => item.scenario === 'subtitle-translate')?.modelIds).toEqual(['deepseek-v4-flash']);
    expect(buildDefaultSceneModelAssignments(openrouter!).find((item) => item.scenario === 'subtitle-translate')?.modelIds).toEqual(['openai/gpt-5.4-mini']);
    expect(buildDefaultSceneModelAssignments(ollama!).every((item) => item.modelIds.length === 0)).toBe(true);

    const zhipu = providerTemplates.find((template) => template.id === 'template-zhipu-glm');
    const tencent = providerTemplates.find((template) => template.id === 'template-tencent-speech');
    const azure = providerTemplates.find((template) => template.id === 'template-azure-openai');
    const gemini = providerTemplates.find((template) => template.id === 'template-gemini');

    expect(buildDefaultSceneModelAssignments(zhipu!).map((item) => [item.scenario, item.modelIds])).toEqual([
      ['watch', ['glm-realtime-flash']],
      ['game', ['glm-realtime-flash']],
      ['voice-room', []],
      ['subtitle-translate', []],
    ]);
    expect(buildDefaultSceneModelAssignments(tencent!).find((item) => item.scenario === 'watch')?.modelIds).toEqual(['hunyuan-translation-lite']);
    expect(buildDefaultSceneModelAssignments(azure!).find((item) => item.scenario === 'watch')?.modelIds).toEqual(['gpt-realtime']);
    expect(buildDefaultSceneModelAssignments(gemini!).find((item) => item.scenario === 'watch')?.modelIds).toEqual(['gemini-3.1-flash-live-preview']);
  });

  it('persists template catalog order, visibility and enabled preferences', () => {
    window.localStorage.clear();
    const listener = vi.fn();
    window.addEventListener(PROVIDER_TEMPLATE_CATALOG_UPDATED_EVENT, listener);
    writeProviderTemplateCatalogPreferences([
      { templateId: 'template-openrouter', enabled: true, order: 0, hidden: true },
    ]);

    expect(readProviderTemplateCatalogPreferences()).toEqual([
      { templateId: 'template-openrouter', enabled: true, order: 0, hidden: true },
    ]);
    expect(listener).toHaveBeenCalledOnce();

    const entries = buildProviderTemplateCatalogEntries(providerTemplates, [
      { templateId: 'template-openrouter', enabled: true, order: -1, hidden: true },
    ]);
    expect(entries[0]?.template.id).toBe('template-openrouter');
    expect(entries[0]).toMatchObject({ enabled: true, hidden: true });

    persistProviderTemplateCatalogEntries(entries.slice(0, 2).reverse());
    expect(readProviderTemplateCatalogPreferences().map((item) => item.order)).toEqual([0, 1]);
    window.removeEventListener(PROVIDER_TEMPLATE_CATALOG_UPDATED_EVENT, listener);
  });

  it('ignores missing, malformed and non-array template catalog preferences', () => {
    window.localStorage.clear();
    expect(readProviderTemplateCatalogPreferences()).toEqual([]);
    window.localStorage.setItem('omni.providerTemplateCatalogPrefs', '{broken-json');
    expect(readProviderTemplateCatalogPreferences()).toEqual([]);
    window.localStorage.setItem('omni.providerTemplateCatalogPrefs', '{}');
    expect(readProviderTemplateCatalogPreferences()).toEqual([]);
  });
});
