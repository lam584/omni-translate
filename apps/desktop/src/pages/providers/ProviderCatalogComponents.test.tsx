import { act, type SetStateAction } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfigDraftMock } from '../../mocks/app-config';
import { providerTemplates } from '../../mocks/provider-templates';
import type { ProviderDraft } from '../../schema/config';
import type { ProviderModelRuntime, ProviderProbeProfileRuntime, ProviderSmokeResult } from '../../schema/provider-runtime';
import type { ProviderTemplateCatalogEntry } from '../../utils/provider-template-catalog';
import type { CustomProviderTemplateDraft } from '../../utils/custom-provider-templates';
import type { ModelCatalogState } from './providersPageHelpers';
import CustomProviderDialog from './CustomProviderDialog';
import ProviderCapabilityRegistryDialog from './ProviderCapabilityRegistryDialog';
import ProviderModelCatalog from './ProviderModelCatalog';
import ProviderTemplateCatalog from './ProviderTemplateCatalog';
import ProviderVerificationPanel from './ProviderVerificationPanel';
import { AudioModeHelpDialog, PendingModelRegistrationDialog } from './ProviderModelDialogs';

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

async function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('provider catalog components', () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
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

  it('renders template catalog empty state and hides add while model catalog is open', async () => {
    const activeProvider = structuredClone(appConfigDraftMock.providers[0]) as ProviderDraft;
    const onAddProvider = vi.fn();
    const onQueryChange = vi.fn();
    ({ container, root } = render(
      <ProviderTemplateCatalog
        activeProvider={activeProvider}
        draggingTemplateId={null}
        entries={[]}
        modelCatalogOpen
        onAddProvider={onAddProvider}
        onApplyTemplate={vi.fn()}
        onMouseDown={vi.fn()}
        onMouseOver={vi.fn()}
        onMouseUp={vi.fn()}
        onQueryChange={onQueryChange}
        onToggleEnabled={vi.fn()}
        query=""
        templateDragMovedRef={{ current: false }}
      />,
    ));

    expect(container.querySelector('.provider-directory-empty')).toBeInstanceOf(HTMLElement);
    expect(container.querySelector('.provider-directory-add')).toBeNull();
    await change(container.querySelector<HTMLInputElement>('.provider-directory-search-input')!, 'dash');
    expect(onQueryChange).toHaveBeenCalledWith('dash');
    expect(onAddProvider).not.toHaveBeenCalled();
  });

  it('applies templates, skips click after drag, and toggles enabled state without applying', async () => {
    const activeProvider = {
      ...(structuredClone(appConfigDraftMock.providers[0]) as ProviderDraft),
      templateId: providerTemplates[0].id,
    };
    const entries: ProviderTemplateCatalogEntry[] = [
      { template: providerTemplates[0], enabled: true, hidden: false, order: 0 },
      { template: providerTemplates[1], enabled: false, hidden: false, order: 1 },
    ];
    const onApplyTemplate = vi.fn();
    const onToggleEnabled = vi.fn();
    const dragMovedRef = { current: false };
    ({ container, root } = render(
      <ProviderTemplateCatalog
        activeProvider={activeProvider}
        draggingTemplateId={providerTemplates[1].id}
        entries={entries}
        modelCatalogOpen={false}
        onAddProvider={vi.fn()}
        onApplyTemplate={onApplyTemplate}
        onMouseDown={vi.fn()}
        onMouseOver={vi.fn()}
        onMouseUp={vi.fn()}
        onQueryChange={vi.fn()}
        onToggleEnabled={onToggleEnabled}
        query=""
        templateDragMovedRef={dragMovedRef}
      />,
    ));

    const items = Array.from(container.querySelectorAll<HTMLButtonElement>('.provider-directory-item'));
    expect(items[0].className).toContain('provider-directory-item-active');
    expect(items[1].className).toContain('provider-directory-item-dragging');

    await click(items[0]);
    expect(onApplyTemplate).toHaveBeenCalledWith(providerTemplates[0].id);

    dragMovedRef.current = true;
    await click(items[1]);
    expect(onApplyTemplate).not.toHaveBeenCalledWith(providerTemplates[1].id);
    expect(dragMovedRef.current).toBe(false);

    await click(items[1].querySelector('.provider-directory-item-state'));
    expect(onToggleEnabled).toHaveBeenCalledWith(providerTemplates[1].id);
  });

  it('renders model catalog categories, uncategorized models, errors and manual add interactions', async () => {
    const catalog: ModelCatalogState = {
      signature: 'runtime-catalog',
      status: 'error',
      source: 'runtime',
      endpoint: 'https://example.test/models',
      fetchedAt: 'bad timestamp',
      error: 'catalog unavailable',
      models: [],
    };
    const categorized: ProviderModelRuntime = {
      id: 'model-a',
      displayName: 'Model A',
      ownedBy: 'owner',
      createdAt: null,
      capabilities: ['speech-to-text'],
    };
    const uncategorized: ProviderModelRuntime = {
      id: 'model-b',
      displayName: 'model-b',
      ownedBy: null,
      createdAt: null,
      capabilities: [],
    };
    const onToggleModel = vi.fn();
    const onManualAdd = vi.fn();
    const onManualDraftChange = vi.fn();
    ({ container, root } = render(
      <ProviderModelCatalog
        catalog={catalog}
        catalogSections={[{ capability: 'speech-to-text', models: [categorized] }]}
        description="Pick a model"
        isModelAdded={(scenario, modelId) => (scenario === 'watch' || scenario === 'all') && modelId === 'model-a'}
        manualModelIdDraft="manual-model"
        onClose={vi.fn()}
        onManualAdd={onManualAdd}
        onManualDraftChange={onManualDraftChange}
        onOpenCapabilityRegistry={vi.fn()}
        onQueryChange={vi.fn()}
        onRefresh={vi.fn()}
        onScenarioChange={vi.fn()}
        onToggleModel={onToggleModel}
        query=""
        selectedScenario="all"
        targetScenario="watch"
        uncategorizedModels={[uncategorized]}
      />,
    ));

    expect(container.querySelector('.provider-inline-alert')?.textContent).toContain('catalog unavailable');
    expect(container.querySelector('.provider-model-item-active')).toBeInstanceOf(HTMLElement);
    expect(container.textContent).toContain('model-b');
    expect(container.querySelector<HTMLInputElement>('.provider-scene-manual-row input')?.value).toBe('manual-model');
    await click(container.querySelector('.provider-model-item-active button'));
    expect(onToggleModel).toHaveBeenCalledWith('watch', categorized);

    const manualInput = container.querySelector<HTMLInputElement>('.provider-scene-manual-row input')!;
    await change(manualInput, 'new-model');
    expect(onManualDraftChange).toHaveBeenCalledWith('new-model');
    await act(async () => {
      manualInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    // onManualAdd 是无参回调：断言“恰好被 Enter 触发一次且不带参数”。
    expect(onManualAdd).toHaveBeenCalledTimes(1);
    expect(onManualAdd).toHaveBeenCalledWith();
  });

  it('renders custom provider dialog dashscope fields and updates the draft', async () => {
    const draft: CustomProviderTemplateDraft = {
      displayName: 'Custom DashScope',
      kind: 'dashscope' as const,
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      model: 'qwen-plus',
      transport: 'websocket' as const,
      authReference: 'credential://provider/custom/dashscope',
      authHeaderName: 'Authorization',
      authScheme: 'bearer' as const,
      region: 'cn-beijing',
      streamEnabled: true,
      timeoutMs: 15000,
      systemPromptTemplate: 'video-realtime-cn',
      protocolProfileKey: '',
    };
    const setDraft = vi.fn((value: SetStateAction<CustomProviderTemplateDraft>) =>
      typeof value === 'function' ? value(draft) : value);
    const onKindChange = vi.fn();
    const onSave = vi.fn();
    ({ container, root } = render(
      <CustomProviderDialog
        draft={draft}
        error="missing key"
        onClose={vi.fn()}
        onKindChange={onKindChange}
        onSave={onSave}
        setDraft={setDraft}
      />,
    ));

    expect(container.querySelector('.provider-inline-alert')?.textContent).toContain('missing key');
    const kindSelect = Array.from(container.querySelectorAll<HTMLSelectElement>('select'))
      .find((select) => select.value === 'dashscope');
    expect(kindSelect?.value).toBe('dashscope');
    await change(kindSelect!, 'openrouter');
    expect(onKindChange).toHaveBeenCalledWith('openrouter');
    await change(container.querySelector<HTMLInputElement>('input[placeholder="cn-beijing"]')!, 'us-east-1');
    // 区域输入的更新器在变更事件内执行（setDraft 桩同步调用），产出仅替换 region 的草稿。
    expect(setDraft).toHaveBeenCalledTimes(1);
    expect(setDraft.mock.results[0]?.value).toStrictEqual({ ...draft, region: 'us-east-1' });
    await click(container.querySelector('.action-button'));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('renders verification details with probe error and smoke event log', async () => {
    const activeProbe = {
      id: 'probe-1',
      templateId: 'template',
      providerId: 'provider',
      verdict: 'realtime-risk' as const,
      checkedAt: '2026-06-06T00:00:00.000Z',
      measuredLatencyMs: 250,
      latencyBudgetMs: 1000,
      transportRequested: 'websocket',
      transportEffective: 'http',
      streamSupported: false,
      fallbackApplied: true,
      errorShapeStable: true,
      responseShapeStable: true,
      checks: [],
      guidance: ['Use HTTP fallback'],
    };
    const probeResult: ProviderProbeProfileRuntime = {
      id: 'probe-1',
      templateId: 'template',
      providerId: 'provider',
      verdict: 'realtime-risk',
      checkedAt: activeProbe.checkedAt,
      measuredLatencyMs: activeProbe.measuredLatencyMs,
      latencyBudgetMs: activeProbe.latencyBudgetMs,
      streamSupported: activeProbe.streamSupported,
      errorShapeStable: true,
      responseShapeStable: true,
      transportRequested: activeProbe.transportRequested,
      transportEffective: activeProbe.transportEffective,
      fallbackApplied: activeProbe.fallbackApplied,
      inputTokens: null,
      outputTokens: null,
      audioSeconds: null,
      connectionAttempts: 1,
      connectionCount: 1,
      connectionOpened: true,
      connectionClosed: true,
      connectionOwner: 'test:probe',
      connectionGeneration: 1,
      checks: [],
      guidance: activeProbe.guidance,
      routingDecision: { subtitlePriority: 'subtitle-first', speechDisposition: 'ready', rationale: 'ok' },
      error: { code: 'timeout', message: 'probe failed', retriable: true, httpStatus: null, providerCode: null, suggestion: 'retry' },
    };
    const smokeResult: ProviderSmokeResult = {
      requestId: 'smoke-1',
      providerId: 'provider',
      status: 'failed',
      transportRequested: 'websocket',
      transportEffective: 'http',
      fallbackApplied: true,
      streamObserved: false,
      durationMs: 900,
      firstEventLatencyMs: null,
      transcript: '',
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      eventLog: [{ eventType: 'error', summary: 'failed', segmentId: null, textDelta: null, text: null, audioChunkRef: null }],
      inputTokens: null,
      outputTokens: null,
      audioSeconds: null,
      connectionAttempts: 1,
      connectionCount: 1,
      connectionOpened: true,
      connectionClosed: true,
      connectionOwner: 'test:smoke',
      connectionGeneration: 1,
      routingDecision: { subtitlePriority: 'balanced', speechDisposition: 'deferred', rationale: 'failed' },
      error: { code: 'timeout', message: 'smoke failed', retriable: true, httpStatus: null, providerCode: null, suggestion: null },
    };
    const onClose = vi.fn();
    ({ container, root } = render(
      <ProviderVerificationPanel
        activeProbe={activeProbe}
        onClose={onClose}
        probeResult={probeResult}
        smokeResult={smokeResult}
        summaryLabel="warning"
        summaryTone="warning"
      />,
    ));

    expect(container.textContent).toContain('Use HTTP fallback');
    expect(container.textContent).toContain('probe failed');
    expect(container.textContent).toContain('smoke failed');
    expect(container.textContent).toContain('failed');
    await click(container.querySelector('.provider-header-icon'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('covers custom timeout fallback and closes the custom dialog from its backdrop', async () => {
    const draft: CustomProviderTemplateDraft = {
      displayName: 'Custom', kind: 'openai-compatible' as const, baseUrl: 'https://example.test', model: 'm',
      transport: 'http' as const, authReference: 'credential://custom', authHeaderName: 'Authorization',
      authScheme: 'none' as const, region: '', streamEnabled: false, timeoutMs: 1000, systemPromptTemplate: '',
      protocolProfileKey: '',
    };
    const setDraft = vi.fn((value: SetStateAction<CustomProviderTemplateDraft>) =>
      typeof value === 'function' ? value(draft) : value);
    const onClose = vi.fn();
    ({ container, root } = render(<CustomProviderDialog draft={draft} error={null} onClose={onClose} onKindChange={vi.fn()} onSave={vi.fn()} setDraft={setDraft} />));
    await change(container.querySelector<HTMLInputElement>('input[type="number"]')!, '');
    // 空输入经 Number('') || 0 回退：更新器应产出 timeoutMs 0，其余字段不变。
    expect(setDraft).toHaveBeenCalledTimes(1);
    expect(setDraft.mock.results[0]?.value).toStrictEqual({ ...draft, timeoutMs: 0 });
    await click(container.querySelector('.modal-backdrop--provider'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders model equality, preset catalog state, and ignores non-Enter manual keys', async () => {
    const model: ProviderModelRuntime = { id: 'same', displayName: 'same', ownedBy: null, createdAt: null, capabilities: [] };
    const onManualAdd = vi.fn();
    ({ container, root } = render(<ProviderModelCatalog
      catalog={{ signature: 's', status: 'ready', source: 'preset', endpoint: null, fetchedAt: null, error: null, models: [model] }}
      catalogSections={[{ capability: 'text-generation', models: [model] }]} description="d" isModelAdded={() => false}
      manualModelIdDraft="" onClose={vi.fn()} onManualAdd={onManualAdd} onManualDraftChange={vi.fn()}
      onOpenCapabilityRegistry={vi.fn()} onQueryChange={vi.fn()} onRefresh={vi.fn()} onScenarioChange={vi.fn()}
      onToggleModel={vi.fn()} query="" selectedScenario="watch" targetScenario="watch" uncategorizedModels={[]} />));
    await act(async () => container!.querySelector<HTMLInputElement>('.provider-scene-manual-row input')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onManualAdd).not.toHaveBeenCalled();
    expect(container.textContent).toContain('same');
  });

  it('handles pending model audio-mode changes and renders audio help', async () => {
    const pending = {
      scenario: 'watch' as const,
      model: { id: 'm', displayName: 'M', ownedBy: null, createdAt: null, capabilities: [] } as ProviderModelRuntime,
      capabilities: ['speech-to-text' as const], realtimeAudioMode: 'server_vad' as const,
      interactionCapabilities: ['streaming' as const],
    };
    const onChange = vi.fn();
    const onHelpClose = vi.fn();
    ({ container, root } = render(<><PendingModelRegistrationDialog pending={pending} onChange={onChange}
      onCapabilityToggle={vi.fn()} onInteractionToggle={vi.fn()} onConfirm={vi.fn()} onClose={vi.fn()} />
      <AudioModeHelpDialog onClose={onHelpClose} /></>));
    const select = container.querySelector<HTMLSelectElement>('select')!;
    await change(select, 'invalid-mode');
    const updater = onChange.mock.calls[0]?.[0] as (current: typeof pending | null) => typeof pending | null;
    expect(updater(null)).toBeNull();
    expect(updater(pending)).toStrictEqual(pending);
    await change(select, 'manual');
    const validUpdater = onChange.mock.calls.at(-1)?.[0] as (current: typeof pending | null) => typeof pending | null;
    expect(validUpdater(pending)?.realtimeAudioMode).toBe('manual');
    // 5 audio modes + 4 model capabilities + 10 interaction capabilities.
    expect(container.querySelectorAll('.audio-mode-help-item')).toHaveLength(19);
    expect(container.querySelectorAll('.audio-mode-help-section-title')).toHaveLength(2);
    await click(container.querySelector('.audio-mode-help-list')?.closest('[role="dialog"]'));
    expect(onHelpClose).not.toHaveBeenCalled();
  });

  it('renders registry column headers, datalist suggestions, and flags duplicate model ids', async () => {
    const entries = [
      { id: 'a', modelId: 'qwen-plus', capabilities: ['speech-to-text' as const] },
      { id: 'b', modelId: ' Qwen-Plus ', capabilities: [] },
      { id: 'c', modelId: '', capabilities: [] },
    ];
    ({ container, root } = render(<ProviderCapabilityRegistryDialog
      entries={entries} modelIdSuggestions={['qwen-plus', 'gpt-4o-realtime']}
      onAdd={vi.fn()} onCapabilityToggle={vi.fn()} onChange={vi.fn()} onClose={vi.fn()}
      onInteractionToggle={vi.fn()} onOpenHelp={vi.fn()} onRemove={vi.fn()} />));

    expect(container.querySelector('.provider-capability-registry-head')).toBeInstanceOf(HTMLElement);
    expect(container.querySelectorAll('datalist option')).toHaveLength(2);
    const rows = Array.from(container.querySelectorAll('.provider-capability-registry-item'));
    expect(rows).toHaveLength(3);
    expect(rows[0]?.querySelector<HTMLInputElement>('input')?.getAttribute('list')).toBe('provider-capability-registry-model-ids');
    // Interaction pills split into 4 semantic groups; 10 pills total per row.
    expect(rows[0]?.querySelectorAll('.provider-capability-registry-interactions .provider-capability-group')).toHaveLength(4);
    expect(rows[0]?.querySelectorAll('.provider-capability-registry-interactions .provider-scenario-pill')).toHaveLength(10);
    // Only the later duplicate is flagged (first entry wins at resolve time); empty ids never are.
    expect(container.querySelectorAll('.provider-capability-registry-duplicate')).toHaveLength(1);
    expect(rows[1]?.querySelector('.provider-capability-registry-duplicate')).toBeInstanceOf(HTMLElement);
  });

  it('renders verification defaults with no probe error and a successful empty smoke result', async () => {
    const activeProbe = {
      id: 'p', templateId: 't', providerId: 'p', verdict: 'available' as const, checkedAt: 'now', measuredLatencyMs: 1,
      latencyBudgetMs: 2, transportRequested: 'http' as const, transportEffective: 'http' as const,
      streamSupported: true, fallbackApplied: false, errorShapeStable: true, responseShapeStable: true, checks: [], guidance: [],
    };
    const smokeResult = {
      requestId: 's', providerId: 'p', status: 'completed' as const, transportRequested: 'http' as const,
      transportEffective: 'http' as const, fallbackApplied: false, streamObserved: true, durationMs: 1,
      firstEventLatencyMs: 0, transcript: '', sourceLanguage: 'en', targetLanguage: 'zh', eventLog: [],
      inputTokens: 0, outputTokens: 0, audioSeconds: 0,
      connectionAttempts: 1, connectionCount: 1,
      connectionOpened: true, connectionClosed: true,
      connectionOwner: 'test:smoke', connectionGeneration: 1,
      routingDecision: { subtitlePriority: 'balanced' as const, speechDisposition: 'ready' as const, rationale: 'ok' }, error: null,
    };
    ({ container, root } = render(<ProviderVerificationPanel activeProbe={activeProbe} probeResult={null}
      smokeResult={smokeResult} summaryLabel="ready" summaryTone="ready" onClose={vi.fn()} />));
    expect(container.querySelector('.result-log')).toBeNull();
    expect(container.textContent).toContain('ready');

    const probeResult: ProviderProbeProfileRuntime = {
      ...activeProbe,
      verdict: 'unavailable' as const,
      inputTokens: null,
      outputTokens: null,
      audioSeconds: null,
      connectionAttempts: 1,
      connectionCount: 1,
      connectionOpened: true,
      connectionClosed: true,
      connectionOwner: 'test:probe',
      connectionGeneration: 1,
      routingDecision: { subtitlePriority: 'balanced', speechDisposition: 'deferred', rationale: 'failed' },
      error: { code: 'failed', message: 'no suggestion', retriable: false, httpStatus: null, providerCode: null, suggestion: null },
    };
    await act(async () => root!.render(<ProviderVerificationPanel activeProbe={activeProbe} probeResult={probeResult}
      smokeResult={smokeResult} summaryLabel="warning" summaryTone="warning" onClose={vi.fn()} />));
    expect(container.textContent).toContain('no suggestion');
  });
});
