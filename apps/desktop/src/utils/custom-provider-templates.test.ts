import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCustomProviderTemplate,
  customProviderTemplateToDraft,
  readCustomProviderTemplates, readCustomProviderTemplatesResult,
  updateCustomProviderTemplate,
  writeCustomProviderTemplates,
  type CustomProviderTemplateDraft,
} from './custom-provider-templates';

function draft(overrides: Partial<CustomProviderTemplateDraft> = {}): CustomProviderTemplateDraft {
  return {
    displayName: ' Custom Provider ',
    kind: 'openai-compatible',
    baseUrl: ' https://example.test/v1 ',
    model: ' model-1 ',
    transport: 'http',
    authReference: 'credential://provider/custom/default',
    authHeaderName: ' Authorization ',
    authScheme: 'bearer',
    region: '',
    streamEnabled: true,
    timeoutMs: 3000,
    systemPromptTemplate: ' prompt ',
    ...overrides,
  };
}

describe('custom provider templates', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00'));
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates normalized OpenAI-compatible templates with generated credential refs', () => {
    const template = createCustomProviderTemplate(draft({ transport: 'streaming-http' }));

    expect(template.id).toContain('template-custom-custom-provider-');
    expect(template.version).toBe('2026.06.01');
    expect(template.protocolLabel).toBe('自定义流式HTTP');
    expect(template.supportedTransports).toEqual(['http', 'streaming-http']);
    expect(template.defaultDraft).toMatchObject({
      providerId: 'provider-custom-custom-provider',
      displayName: 'Custom Provider',
      baseUrl: 'https://example.test/v1',
      model: 'model-1',
      region: undefined,
    });
    expect(template.defaultDraft.auth.reference).toBe('credential://provider/custom/custom-provider');
  });

  it('adds DashScope region fields and preserves explicit credentials', () => {
    const template = createCustomProviderTemplate(
      draft({
        displayName: '实时语音',
        kind: 'dashscope',
        transport: 'websocket',
        authReference: ' credential://provider/custom/realtime ',
        region: ' cn-beijing ',
      }),
    );

    expect(template.protocolLabel).toBe('自定义长连接');
    expect(template.supportedTransports).toEqual(['http', 'websocket']);
    expect(template.defaultDraft.auth.reference).toBe('credential://provider/custom/realtime');
    expect(template.defaultDraft.region).toBe('cn-beijing');
    expect(template.fieldGroups.flatMap((group) => group.fields).some((field) => field.key === 'region')).toBe(true);
  });

  it('round-trips drafts and updates templates without losing their identity', () => {
    const template = createCustomProviderTemplate(draft());
    const updated = updateCustomProviderTemplate(
      { ...template, defaultDraft: { ...template.defaultDraft, providerId: '' } },
      draft({ displayName: ' Updated ', transport: 'streaming-http', authReference: '' }),
    );

    expect(updated.id).toBe(template.id);
    expect(updated.defaultDraft.providerId).toBe('provider-custom-updated');
    expect(customProviderTemplateToDraft(updated)).toMatchObject({
      displayName: 'Updated',
      transport: 'streaming-http',
      authReference: 'credential://provider/custom/updated',
    });
  });

  it('updates existing templates to DashScope transport without replacing provider identity', () => {
    const template = createCustomProviderTemplate(draft());
    const updated = updateCustomProviderTemplate(template, draft({ kind: 'dashscope', transport: 'websocket' }));

    expect(updated.defaultDraft.providerId).toBe(template.defaultDraft.providerId);
    expect(updated.description).toContain('DashScope');
    expect(updated.supportedTransports).toEqual(['http', 'websocket']);
  });

  it('persists custom templates and ignores missing, non-array and malformed storage', () => {
    expect(readCustomProviderTemplates()).toEqual([]);
    const template = createCustomProviderTemplate(draft());
    expect(writeCustomProviderTemplates([template]).ok).toBe(true);
    expect(readCustomProviderTemplates()).toEqual([template]);

    window.localStorage.setItem('omni.customProviderTemplates', '{}');
    expect(readCustomProviderTemplates()).toEqual([]);
    window.localStorage.setItem('omni.customProviderTemplates', '{broken-json');
    expect(readCustomProviderTemplates()).toEqual([]);
    expect(readCustomProviderTemplatesResult().error).toBeTruthy();
    expect(window.localStorage.getItem('omni.customProviderTemplates')).toBe('{broken-json');
  });

  it('ignores template persistence when browser storage is unavailable', () => {
    vi.stubGlobal('window', undefined);
    expect(readCustomProviderTemplates()).toEqual([]);
    expect(writeCustomProviderTemplates([]).ok).toBe(false);
    vi.unstubAllGlobals();
  });
});
