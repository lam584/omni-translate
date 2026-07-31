import { act, type Dispatch, type SetStateAction } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfigDraftMock } from '../../mocks/app-config';
import { providerTemplates } from '../../mocks/provider-templates';
import type { ProviderDraft, ProviderScenario } from '../../schema/config';
import type { ProviderModelRuntime } from '../../schema/provider-runtime';
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
    sceneAssignments: structuredClone(activeProvider.sceneModelAssignments),
    modelLookup: new Map<string, ProviderModelRuntime>([
      ['qwen3.5-omni-plus-realtime', makeModel('qwen3.5-omni-plus-realtime', ['realtime-audio'])],
    ]),
    localModelCapabilityRegistry: [],
    setSecretDraft: vi.fn() as Dispatch<SetStateAction<string>>,
    setDraggingSceneModel: vi.fn() as Dispatch<SetStateAction<{ scenario: ProviderScenario; modelId: string } | null>>,
    updateActiveProviderDraft: vi.fn(),
    onDelete: vi.fn(),
    onVerify: vi.fn().mockResolvedValue(undefined),
    onVerificationDetails: vi.fn(),
    onOpenModelCatalog: vi.fn(),
    onOpenAdvancedSettings: vi.fn(),
    onSecretVisibilityToggle: vi.fn().mockResolvedValue(undefined),
    onSecretSave: vi.fn().mockResolvedValue(undefined),
    onSceneModelReorder: vi.fn(),
    onSceneModelRemove: vi.fn(),
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

  it('renders scene model assignments with model items and capability chips', () => {
    ({ container, root } = render(<ProviderStudio {...baseProps()} />));

    const sceneCards = container.querySelectorAll('.provider-scene-card');
    expect(sceneCards.length).toBe(4);

    const watchCard = sceneCards[0];
    expect(watchCard?.textContent).toContain('qwen3.5-omni-plus-realtime');
    const capabilityChip = watchCard?.querySelector('.provider-capability-chip');
    expect(capabilityChip).toBeInstanceOf(HTMLElement);
  });

  it('shows empty state for scenes without models', () => {
    ({ container, root } = render(<ProviderStudio {...baseProps()} />));

    const emptyStates = container.querySelectorAll('.provider-scene-empty');
    expect(emptyStates.length).toBe(2);
    expect(emptyStates[0]?.textContent).toContain('尚未添加模型');
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

  it('removes scene model via remove button', async () => {
    const props = baseProps();
    ({ container, root } = render(<ProviderStudio {...props} />));

    const removeButton = container.querySelector('.provider-scene-model-actions .provider-header-icon-danger');
    expect(removeButton).toBeInstanceOf(HTMLButtonElement);
    await click(removeButton);
    expect(props.onSceneModelRemove).toHaveBeenCalledWith('watch', 'qwen3.5-omni-plus-realtime');
  });

  it('shows model catalog endpoint footnote when provided', () => {
    ({ container, root } = render(<ProviderStudio {...baseProps({
      modelCatalogEndpoint: 'https://api.example.com/v1/models',
    })} />));

    const footnote = container.querySelector('.provider-setting-footnote');
    expect(footnote?.textContent).toContain('https://api.example.com/v1/models');
  });
});
