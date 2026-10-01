import { act, type Dispatch, type SetStateAction } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfigDraftMock } from '../../mocks/app-config';
import { providerTemplates } from '../../mocks/provider-templates';
import type { ProviderDraft } from '../../schema/config';
import type { ProviderModelRuntime } from '../../schema/provider-runtime';
import { buildProviderDraftPatchFromTemplate } from '../../utils/provider-draft';
import ProviderStudio from './ProviderStudio';

function render(element: React.ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

async function click(element: Element | null | undefined) {
  expect(element).toBeInstanceOf(Element);
  await act(async () => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

const activeProvider = structuredClone(appConfigDraftMock.providers[0]) as ProviderDraft;
const activeTemplate = providerTemplates.find((t) => t.id === activeProvider.templateId) ?? providerTemplates[0];

function makeModel(id: string, capabilities: string[] = []): ProviderModelRuntime {
  return { id, displayName: id, ownedBy: null, createdAt: null, capabilities: capabilities as ProviderModelRuntime['capabilities'] };
}

function baseProps(overrides: Partial<React.ComponentProps<typeof ProviderStudio>> = {}) {
  return {
    activeProvider: structuredClone(activeProvider),
    activeTemplate,
    busyAction: null as 'secret' | 'secret-reveal' | 'verify' | null,
    providerRuntimeBlocked: false,
    providerRuntimeStatusMessage: null as string | null,
    storagePollError: null as string | null,
    onStorageRetry: vi.fn(),
    hasVerificationDetail: false,
    secretDraft: '',
    secretStored: false,
    secretVisible: false,
    secretStatusMessage: null as string | null,
    modelCatalogEndpoint: null as string | null,
    modelLookup: new Map<string, ProviderModelRuntime>([
      ['qwen3.5-omni-plus-realtime', makeModel('qwen3.5-omni-plus-realtime', ['realtime-audio'])],
      ['qwen3.5-livetranslate-flash-realtime', makeModel('qwen3.5-livetranslate-flash-realtime', ['realtime-audio'])],
    ]),
    localModelCapabilityRegistry: [],
    setSecretDraft: vi.fn() as Dispatch<SetStateAction<string>>,
    updateActiveProviderDraft: vi.fn(),
    onDelete: vi.fn(),
    onVerify: vi.fn().mockResolvedValue(undefined),
    onVerificationDetails: vi.fn(),
    onOpenModelCatalog: vi.fn(),
    onOpenAdvancedSettings: vi.fn(),
    onSecretVisibilityToggle: vi.fn().mockResolvedValue(undefined),
    onSecretSave: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('ProviderStudio', () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    container?.remove();
    root = null;
    container = null;
    vi.restoreAllMocks();
  });

  it('renders data-backed Workspace candidates without quick-preset buttons', () => {
    const template = providerTemplates.find((item) => item.id === 'template-dashscope-workspace')!;
    const provider = { ...structuredClone(activeProvider), templateId: template.id,
      baseUrl: 'wss://my-workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',
      candidateModelGroups: buildProviderDraftPatchFromTemplate(activeProvider, template).candidateModelGroups };
    const props = baseProps({ activeTemplate: template, activeProvider: provider, modelLookup: new Map() });
    ({ container, root } = render(<ProviderStudio {...props} />));
    expect(container.querySelectorAll('.provider-scene-model-item')).toHaveLength(4);
    expect(container.textContent).toContain('qwen3.8-flash');
    expect(container.textContent).toContain('qwen3.8-livetranslate-flash-realtime');
    expect(container.textContent).toContain('qwen3.8-omni-flash-realtime');
    expect(container.querySelector('[data-testid^="candidate-presets-"]')).toBeNull();
    expect(container.querySelector('.provider-scene-grid input')).toBeNull();
    expect(container.querySelectorAll('.provider-scene-card-header button')).toHaveLength(4);
    expect(props.updateActiveProviderDraft).not.toHaveBeenCalled();

    act(() => { root?.unmount(); root = null; });
    container?.remove();
    ({ container, root } = render(<ProviderStudio {...baseProps({ activeTemplate: template,
      activeProvider: { ...provider, candidateModelGroups: [] }, modelLookup: new Map() })} />));
    expect(container.querySelector('[data-testid^="candidate-presets-"]')).toBeNull();
    expect(container.querySelectorAll('.provider-scene-model-item')).toHaveLength(0);
  });
  it('hides the generic binding editor for Bailian without changing stored protocol bindings', () => {
    const template = providerTemplates.find((item) => item.id === 'template-dashscope-realtime')!;
    const bindings = [{
      modelId: 'qwen3.5-livetranslate-flash-realtime',
      operation: 'realtime-translation',
      profileOwnerProviderId: 'bailian',
      manifestVersion: 1,
      profileId: 'bailian.livetranslate.realtime.ws',
      profileVersion: 1,
    }];
    const provider = {
      ...structuredClone(activeProvider),
      kind: 'dashscope' as const,
      templateId: template.id,
      model: bindings[0]!.modelId,
      modelProtocolBindings: bindings,
    };
    const props = baseProps({ activeTemplate: template, activeProvider: provider });
    const originalBindings = structuredClone(props.activeProvider.modelProtocolBindings);
    ({ container, root } = render(<ProviderStudio {...props} />));

    const bindingEditorCard = Array.from(container.querySelectorAll('.provider-panel-card'))
      .find((card) => card.querySelector('h3')?.textContent?.includes('/'));
    expect(bindingEditorCard).toBeUndefined();
    expect(props.activeProvider.modelProtocolBindings).toEqual(originalBindings);
    expect(props.updateActiveProviderDraft).not.toHaveBeenCalled();
  });

  it('keeps the generic binding editor visible for non-Bailian providers', () => {
    const template = providerTemplates.find((item) => item.id === 'template-openai-compatible-realtime')!;
    const provider = {
      ...structuredClone(activeProvider),
      kind: 'openai-compatible' as const,
      templateId: template.id,
      model: 'gpt-4o',
    };
    ({ container, root } = render(<ProviderStudio {...baseProps({ activeTemplate: template, activeProvider: provider })} />));

    const bindingEditorCard = Array.from(container.querySelectorAll('.provider-panel-card'))
      .find((card) => card.querySelector('h3')?.textContent?.includes('/'));
    expect(bindingEditorCard).toBeInstanceOf(HTMLElement);
  });

  it('renders provider header with template display name and delete action', async () => {
    const props = baseProps();
    ({ container, root } = render(<ProviderStudio {...props} />));

    const header = container.querySelector('.provider-studio-header');
    expect(header).toBeInstanceOf(HTMLElement);
    expect(header?.textContent).toContain(activeTemplate.displayName);

    const deleteButton = container.querySelector('.provider-header-icon-danger');
    expect(deleteButton).toBeInstanceOf(HTMLButtonElement);
    await click(deleteButton);
    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  it('shows auth saved badge when secret is stored and not-saved when absent', () => {
    ({ container, root } = render(<ProviderStudio {...baseProps({ secretStored: true })} />));
    const badges = Array.from(container.querySelectorAll('.status-badge'));
    const authBadge = badges.find((badge) => badge.closest('.provider-panel-heading'));
    expect(authBadge?.textContent).toContain('已保存');

    act(() => { root?.unmount(); root = null; });
    container?.remove();

    ({ container, root } = render(<ProviderStudio {...baseProps({ secretStored: false })} />));
    const badgesDraft = Array.from(container.querySelectorAll('.status-badge'));
    const authBadgeDraft = badgesDraft.find((badge) => badge.closest('.provider-panel-heading'));
    expect(authBadgeDraft?.textContent).toContain('未保存');
  });

  it('disables verify button when busy or runtime blocked', () => {
    ({ container, root } = render(<ProviderStudio {...baseProps({ busyAction: 'verify' })} />));
    const verifyButton = container.querySelector<HTMLButtonElement>('.provider-primary-action');
    expect(verifyButton?.disabled).toBe(true);

    act(() => { root?.unmount(); root = null; });
    container?.remove();

    ({ container, root } = render(<ProviderStudio {...baseProps({ providerRuntimeBlocked: true })} />));
    const blockedButton = container.querySelector<HTMLButtonElement>('.provider-primary-action');
    expect(blockedButton?.disabled).toBe(true);
  });

  it('disables secret save when no draft and no baseUrl', () => {
    const props = baseProps({
      secretDraft: '',
      activeProvider: { ...structuredClone(activeProvider), baseUrl: '' },
    });
    ({ container, root } = render(<ProviderStudio {...props} />));

    const saveButton = Array.from(container.querySelectorAll<HTMLButtonElement>('.action-button'))
      .find((btn) => btn.textContent?.includes('保存密钥'));
    expect(saveButton?.disabled).toBe(true);
  });

  it('enables secret save when draft has content', async () => {
    const props = baseProps({ secretDraft: 'sk-test-key-123' });
    ({ container, root } = render(<ProviderStudio {...props} />));

    const saveButton = Array.from(container.querySelectorAll<HTMLButtonElement>('.action-button'))
      .find((btn) => btn.textContent?.includes('保存密钥'));
    expect(saveButton?.disabled).toBe(false);
    await click(saveButton);
    expect(props.onSecretSave).toHaveBeenCalledTimes(1);
  });

  it('renders four empty capability-based candidate groups, ignoring old scene selections', () => {
    ({ container, root } = render(<ProviderStudio {...baseProps()} />));
    const cards = container.querySelectorAll('.provider-scene-card');
    expect(cards).toHaveLength(4);
    expect(cards[0]?.textContent).toContain('文本处理与翻译');
    expect(cards[1]?.textContent).toContain('语音识别与理解');
    expect(cards[2]?.textContent).toContain('语音生成');
    expect(cards[3]?.textContent).toContain('实时语音与多模态');
    expect(container.querySelectorAll('.provider-scene-empty')).toHaveLength(4);
    expect(container.querySelectorAll('.provider-scene-model-item')).toHaveLength(0);
  });
  it('displays storage poll error alert with retry button', async () => {
    const props = baseProps({ storagePollError: 'connection refused' });
    ({ container, root } = render(<ProviderStudio {...props} />));

    const alert = container.querySelector('[role="alert"]');
    expect(alert).toBeInstanceOf(HTMLElement);
    expect(alert?.textContent).toContain('connection refused');

    const retryButton = alert?.querySelector('button');
    await click(retryButton);
    expect(props.onStorageRetry).toHaveBeenCalledTimes(1);
  });

  it('shows verification details button only when detail exists', () => {
    ({ container, root } = render(<ProviderStudio {...baseProps({ hasVerificationDetail: false })} />));
    expect(container.textContent).not.toContain('验证详情');

    act(() => { root?.unmount(); root = null; });
    container?.remove();

    ({ container, root } = render(<ProviderStudio {...baseProps({ hasVerificationDetail: true })} />));
    expect(container.textContent).toContain('验证详情');
  });

  it('triggers model catalog and advanced settings callbacks', async () => {
    const props = baseProps();
    ({ container, root } = render(<ProviderStudio {...props} />));

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('.icon-button'));
    const catalogButton = buttons.find((btn) => btn.textContent?.includes('模型列表'));
    const advancedButton = buttons.find((btn) => btn.textContent?.includes('高级设置'));

    await click(catalogButton);
    expect(props.onOpenModelCatalog).toHaveBeenCalledTimes(1);

    await click(advancedButton);
    expect(props.onOpenAdvancedSettings).toHaveBeenCalledTimes(1);
  });

  it('renders secret status message and provider runtime warning', () => {
    ({ container, root } = render(<ProviderStudio {...baseProps({
      secretStatusMessage: 'API key loaded',
      providerRuntimeStatusMessage: 'Runtime unreachable',
    })} />));

    const alerts = container.querySelectorAll('.provider-inline-alert');
    expect(alerts.length).toBe(2);
    expect(alerts[0]?.textContent).toContain('API key loaded');
    expect(alerts[1]?.textContent).toContain('Runtime unreachable');
  });

  it('removes a candidate from its group without changing credentials or capabilities', async () => {
    const provider = { ...structuredClone(activeProvider), candidateModelGroups: [
      { group: 'realtime-multimodal' as const, modelIds: ['qwen3.5-livetranslate-flash-realtime'] },
    ] };
    const props = baseProps({ activeProvider: provider });
    ({ container, root } = render(<ProviderStudio {...props} />));
    const removeButton = container.querySelector('.provider-scene-model-actions .provider-header-icon-danger');
    await click(removeButton);
    expect(props.updateActiveProviderDraft).toHaveBeenCalledWith(expect.objectContaining({
      candidateModelGroups: expect.arrayContaining([{ group: 'realtime-multimodal', modelIds: [] }]),
      status: 'draft',
    }));
  });

  it('opens the catalog for a candidate group without showing a manual ID field', async () => {
    const props = baseProps();
    ({ container, root } = render(<ProviderStudio {...props} />));
    const card = container.querySelectorAll('.provider-scene-card')[2];
    expect(card?.querySelector('input, datalist, .provider-scene-manual-row')).toBeNull();
    await click(card?.querySelector('.provider-scene-card-header button'));
    expect(props.onOpenModelCatalog).toHaveBeenCalledWith('audio-generation');
  });
  it('displays selected official metadata modalities without inferred capabilities', () => {
    const provider = {
      ...structuredClone(activeProvider),
      candidateModelGroups: [{ group: 'audio-understanding' as const, modelIds: ['metadata-only-model'] }],
      modelMetadataCache: {
        source: 'bailian-api' as const,
        fetchedAt: new Date().toISOString(),
        endpoint: 'https://dashscope.aliyuncs.com',
        models: [{
          modelId: 'metadata-only-model', categories: ['audio'],
          requestModalities: ['audio', 'text'], responseModalities: ['text'],
        }, { modelId: 'unselected-official-model', categories: [], requestModalities: [], responseModalities: [] }],
      },
    };
    ({ container, root } = render(<ProviderStudio {...baseProps({ activeProvider: provider, modelLookup: new Map() })} />));

    const card = container.querySelectorAll('.provider-scene-card')[1];
    expect(card?.querySelector('input, datalist')).toBeNull();
    const selected = card?.querySelector('.provider-scene-model-item');
    expect(selected?.textContent).toContain('metadata-only-model');
    expect(selected?.textContent).toContain('输入：audio, text');
    expect(selected?.textContent).toContain('输出：text');
    expect(selected?.querySelector('.provider-capability-chip')).toBeNull();
  });
  it('ignores expired provider metadata in candidate suggestions and modality details', () => {
    const provider = {
      ...structuredClone(activeProvider),
      candidateModelGroups: [{ group: 'audio-understanding' as const, modelIds: ['saved-model'] }],
      modelMetadataCache: {
        source: 'bailian-api' as const,
        fetchedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
        endpoint: 'https://dashscope.aliyuncs.com/api/v1/models',
        models: [
          { modelId: 'saved-model', categories: ['audio'], requestModalities: ['audio'], responseModalities: ['text'] },
          { modelId: 'expired-suggestion', categories: [], requestModalities: [], responseModalities: [] },
        ],
      },
    };
    ({ container, root } = render(<ProviderStudio {...baseProps({ activeProvider: provider, modelLookup: new Map() })} />));
    const card = container.querySelectorAll('.provider-scene-card')[1];
    expect(Array.from(card?.querySelectorAll('datalist option') ?? []).map((option) => option.getAttribute('value'))).not.toContain('expired-suggestion');
    expect(card?.querySelector('.provider-scene-model-item')?.textContent).toContain('saved-model');
    expect(card?.querySelector('.provider-scene-model-item')?.textContent).not.toContain('输入：');
  });  it('shows model catalog endpoint footnote when provided', () => {
    ({ container, root } = render(<ProviderStudio {...baseProps({
      modelCatalogEndpoint: 'https://api.example.com/v1/models',
    })} />));

    const footnotes = Array.from(container.querySelectorAll('.provider-setting-footnote'));
    expect(footnotes.some((note) => note.textContent?.includes('https://api.example.com/v1/models'))).toBe(true);
  });
  it('lets an empty custom platform bind a candidate model without changing platform identity', async () => {
    const provider = { ...structuredClone(activeProvider), templateSource: 'custom' as const,
      kind: 'openai-compatible' as const, model: '', transport: 'streaming-http' as const,
      authRef: { ...activeProvider.authRef, headerName: 'Authorization', scheme: 'bearer' as const },
      modelProtocolBindings: [], candidateModelGroups: [{ group: 'text-processing' as const, modelIds: ['first-model', 'second-model'] }],
      localModelCapabilityRegistry: [{ id: 'first-capability', modelId: 'first-model', capabilities: ['text-generation' as const], source: 'manual' as const }] };
    const template = { ...activeTemplate, id: 'template-custom-sample', source: 'custom' as const };
    const props = baseProps({ activeProvider: provider, activeTemplate: template, localModelCapabilityRegistry: provider.localModelCapabilityRegistry });
    ({ container, root } = render(<ProviderStudio {...props} />));
    const card = Array.from(container.querySelectorAll('.provider-panel-card'))
      .find((node) => node.textContent?.includes('为模型绑定操作协议'))!;
    const selects = card.querySelectorAll<HTMLSelectElement>('select');
    expect(selects[0]?.options).toHaveLength(2);
    const option = Array.from(selects[1]?.options ?? []).find((item) => item.value.includes('text-translation'))!;
    expect(option).toBeInstanceOf(HTMLOptionElement);
    await act(async () => { selects[1]!.value = option.value; selects[1]!.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(props.updateActiveProviderDraft).toHaveBeenCalledWith(expect.objectContaining({
      modelProtocolBindings: [expect.objectContaining({ modelId: 'first-model', operation: 'text-translation' })],
    }));
    expect(provider.model).toBe('');
  });  it('shows the exact native authority for a custom DashScope platform at an official URL', () => {
    const provider = { ...structuredClone(activeProvider), templateId: 'template-custom-bailian', templateSource: 'custom' as const,
      kind: 'dashscope' as const, transport: 'websocket' as const, model: '', region: 'cn-beijing',
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      authRef: { ...activeProvider.authRef, headerName: 'Authorization', scheme: 'bearer' as const },
      candidateModelGroups: [{ group: 'realtime-multimodal' as const, modelIds: ['qwen3.5-livetranslate-flash-realtime'] }],
      modelProtocolBindings: [] };
    const template = { ...activeTemplate, id: provider.templateId, source: 'custom' as const };
    ({ container, root } = render(<ProviderStudio {...baseProps({ activeProvider: provider, activeTemplate: template })} />));
    expect(container.textContent).toContain('bailian.livetranslate.realtime.ws@1');
    expect(container.textContent).not.toContain('OpenAI API · openai.realtime');
  });});
