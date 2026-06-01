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
      ]),
    );
  });

  it('enables only Aliyun Bailian and DeepSeek by default', () => {
    const entries = buildProviderTemplateCatalogEntries(providerTemplates, []);
    const enabledTemplateIds = entries.filter((entry) => entry.enabled).map((entry) => entry.template.id);

    expect(enabledTemplateIds).toEqual(['template-dashscope-realtime', 'template-deepseek']);
  });

  it('uses provider-specific default scene models', () => {
    const dashscope = providerTemplates.find((template) => template.id === 'template-dashscope-realtime');
    const deepseek = providerTemplates.find((template) => template.id === 'template-deepseek');
    const openrouter = providerTemplates.find((template) => template.id === 'template-openrouter');
    const ollama = providerTemplates.find((template) => template.id === 'template-ollama');

    expect(buildDefaultSceneModelAssignments(dashscope!).map((item) => [item.scenario, item.modelIds])).toEqual([
      ['watch', ['qwen3.5-omni-plus-realtime']],
      ['game', ['qwen3.5-omni-plus-realtime']],
      ['voice-room', ['qwen3.5-omni-plus-realtime']],
      ['subtitle-translate', ['qwen3.6-flash']],
    ]);
    expect(buildDefaultSceneModelAssignments(deepseek!).find((item) => item.scenario === 'subtitle-translate')?.modelIds).toEqual(['deepseek-v4-flash']);
    expect(buildDefaultSceneModelAssignments(openrouter!).find((item) => item.scenario === 'subtitle-translate')?.modelIds).toEqual(['openai/gpt-5.4-mini']);
    expect(buildDefaultSceneModelAssignments(ollama!).every((item) => item.modelIds.length === 0)).toBe(true);
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
