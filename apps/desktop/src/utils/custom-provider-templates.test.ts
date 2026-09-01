import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCustomProviderTemplate,
  customProviderTemplateToDraft,
  readCustomProviderTemplates, readCustomProviderTemplatesResult,
  updateCustomProviderTemplate,
  writeCustomProviderTemplates,
  type CustomProviderTemplateDraft,
} from './custom-provider-templates';
import { customProviderProtocolProfileOptions } from '../provider-manifest/custom-profile-options';

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
    protocolProfileKey: customProviderProtocolProfileOptions('openai-compatible')[0]?.key ?? '',
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
    expect(template.supportedTransports).toEqual(['streaming-http']);
    expect(template.defaultDraft).toMatchObject({
      providerId: 'provider-custom-custom-provider',
      displayName: 'Custom Provider',
      baseUrl: 'https://example.test/v1',
      model: 'model-1',
      region: undefined,
    });
    expect(template.defaultDraft.auth.reference).toBe('credential://provider/custom/custom-provider');
  });

  it('rejects DashScope custom templates until a native profile explicitly permits reuse', () => {
    expect(() => createCustomProviderTemplate(
      draft({
        displayName: '实时语音',
        kind: 'dashscope',
        transport: 'websocket',
        authReference: ' credential://provider/custom/realtime ',
        region: ' cn-beijing ',
        protocolProfileKey: '',
      }),
    )).toThrow('custom_provider.protocol_profile_required');
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

  it('does not silently migrate an existing template to an unapproved DashScope protocol', () => {
    const template = createCustomProviderTemplate(draft());
    expect(() => updateCustomProviderTemplate(template, draft({
      kind: 'dashscope',
      transport: 'websocket',
      protocolProfileKey: '',
    }))).toThrow('custom_provider.protocol_profile_required');
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
    expect(readCustomProviderTemplatesResult().error).toMatch(/JSON/);
    expect(window.localStorage.getItem('omni.customProviderTemplates')).toBe('{broken-json');
  });

  it('migrates uniquely identified legacy profiles and preserves unresolved templates for repair', () => {
    const realtime = customProviderProtocolProfileOptions('openai-compatible')
      .find((option) => option.operation === 'realtime-conversation')!;
    const current = createCustomProviderTemplate(draft({
      displayName: 'Current',
      protocolProfileKey: realtime.key,
    }));
    const legacy = structuredClone(current);
    legacy.id = 'template-custom-legacy-realtime';
    legacy.realtimeProtocol = 'openai-conversation';
    delete legacy.defaultDraft.modelProtocolBindings;
    window.localStorage.setItem('omni.customProviderTemplates', JSON.stringify([current, legacy]));

    const migrated = readCustomProviderTemplatesResult();

    expect(migrated.templates).toHaveLength(2);
    expect(migrated.templates[1]?.defaultDraft.modelProtocolBindings?.[0]).toMatchObject({
      profileOwnerProviderId: 'openai',
      operation: 'realtime-conversation',
    });
    expect(migrated.error).toContain('1 legacy template(s) migrated');
    expect(window.localStorage.getItem('omni.customProviderTemplates')).toContain('modelProtocolBindings');

    const unresolved = structuredClone(current);
    unresolved.id = 'template-custom-unresolved';
    delete unresolved.realtimeProtocol;
    delete unresolved.defaultDraft.modelProtocolBindings;
    window.localStorage.setItem('omni.customProviderTemplates', JSON.stringify([current, unresolved]));
    const preserved = readCustomProviderTemplatesResult();
    expect(preserved.templates.map((template) => template.id)).toEqual([current.id, unresolved.id]);
    expect(preserved.error).toContain('require an explicit Protocol Profile');
  });

  it('ignores template persistence when browser storage is unavailable', () => {
    vi.stubGlobal('window', undefined);
    expect(readCustomProviderTemplates()).toEqual([]);
    expect(writeCustomProviderTemplates([]).ok).toBe(false);
    vi.unstubAllGlobals();
  });
});
