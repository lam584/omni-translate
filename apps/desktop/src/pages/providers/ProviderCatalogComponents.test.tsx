import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfigDraftMock } from '../../mocks/app-config';
import { providerTemplates } from '../../mocks/provider-templates';
import type { ProviderDraft } from '../../schema/config';
import type { ProviderModelRuntime, ProviderProbeProfileRuntime, ProviderSmokeResult } from '../../schema/provider-runtime';
import type { ProviderTemplateCatalogEntry } from '../../utils/provider-template-catalog';
import type { ModelCatalogState } from './providersPageHelpers';
import CustomProviderDialog from './CustomProviderDialog';
import ProviderModelCatalog from './ProviderModelCatalog';
import ProviderTemplateCatalog from './ProviderTemplateCatalog';
import ProviderVerificationPanel from './ProviderVerificationPanel';

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
  expect(element).toBeTruthy();
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

    expect(container.querySelector('.provider-directory-empty')).toBeTruthy();
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
    expect(container.querySelector('.provider-model-item-active')).toBeTruthy();
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
    expect(onManualAdd).toHaveBeenCalled();
  });

  it('renders custom provider dialog dashscope fields and updates the draft', async () => {
    const draft = {
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
    };
    const setDraft = vi.fn();
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
    await change(container.querySelectorAll<HTMLSelectElement>('select')[0], 'openrouter');
    expect(onKindChange).toHaveBeenCalledWith('openrouter');
    await change(container.querySelector<HTMLInputElement>('input[placeholder="cn-beijing"]')!, 'us-east-1');
    expect(setDraft).toHaveBeenCalled();
    await click(container.querySelector('.action-button'));
    expect(onSave).toHaveBeenCalled();
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
      checks: [],
      guidance: activeProbe.guidance,
      routingDecision: { subtitlePriority: 'subtitle-first', speechDisposition: 'ready', rationale: 'ok' },
      error: { code: 'timeout', message: 'probe failed', retriable: true, suggestion: 'retry' },
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
      eventLog: [{ eventType: 'error', summary: 'failed' }],
      inputTokens: null,
      outputTokens: null,
      audioSeconds: null,
      routingDecision: { subtitlePriority: 'balanced', speechDisposition: 'deferred', rationale: 'failed' },
      error: { code: 'timeout', message: 'smoke failed', retriable: true },
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
    expect(onClose).toHaveBeenCalled();
  });
});
