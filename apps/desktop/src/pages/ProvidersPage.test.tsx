import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { appConfigDraftMock } from '../mocks/app-config';
import { providerTemplates } from '../mocks/provider-templates';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import { useAppStore } from '../stores/app-store';
import ProvidersPage, { providersPageHelpers } from './ProvidersPage';

const invokeMock = vi.fn();
const getProviderSecretStatusMock = vi.fn();
const saveProviderSecretMock = vi.fn();
const readProviderSecretMock = vi.fn();
const runProviderProbeMock = vi.fn();
const runProviderSmokeMock = vi.fn();
const fetchProviderModelsMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTauri: () => Boolean((globalThis as typeof globalThis & { isTauri?: boolean }).isTauri),
}));

vi.mock('../runtime/provider-runtime', () => ({
  fetchProviderModels: (...args: unknown[]) => fetchProviderModelsMock(...args),
  getProviderSecretStatus: (...args: unknown[]) => getProviderSecretStatusMock(...args),
  saveProviderSecret: (...args: unknown[]) => saveProviderSecretMock(...args),
  readProviderSecret: (...args: unknown[]) => readProviderSecretMock(...args),
  runProviderProbe: (...args: unknown[]) => runProviderProbeMock(...args),
  runProviderSmoke: (...args: unknown[]) => runProviderSmokeMock(...args),
}));

function cloneStoreState() {
  return {
    configDraft: structuredClone(appConfigDraftMock),
    runtimeSnapshot: structuredClone(runtimeSnapshotMock),
    audioRuntimeSnapshot: structuredClone(audioRuntimeSnapshotMock),
  };
}

function setTauriRuntime(enabled: boolean) {
  if (enabled) {
    Object.defineProperty(globalThis, 'isTauri', {
      value: true,
      writable: true,
      configurable: true,
    });
    return;
  }

  Reflect.deleteProperty(globalThis, 'isTauri');
}

function buttons(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
}

function buttonByText(container: HTMLElement, text: string) {
  const exact = buttons(container).find((button) => button.textContent?.trim() === text);
  if (exact) return exact;

  if (text === '\u767b\u8bb0\u5e76\u6dfb\u52a0') {
    return container.querySelector<HTMLButtonElement>('.provider-modal-actions .provider-primary-action');
  }
  if (text.includes('create') || text.includes('平台') || text.includes('鍒涘缓') || text.includes('閸掓稑')) {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('.provider-modal-actions button')).at(-1);
  }
  if (text.includes('manual') || text.includes('手动') || text.includes('鎵嬪姩') || text.includes('閹靛')) {
    return manualModelAddButton(container);
  }
  if (text.includes('cancel') || text.includes('取消') || text.includes('鍙栨秷') || text.includes('閸欐牗')) {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('.provider-modal-actions button')).at(0);
  }

  const modalAction = Array.from(container.querySelectorAll<HTMLButtonElement>('.provider-modal-actions button')).at(-1);
  if (modalAction) return modalAction;

  return undefined;
}

function buttonContainingText(container: HTMLElement, text: string) {
  const containing = buttons(container).find((button) => button.textContent?.includes(text));
  if (containing) return containing;

  if (text.includes('advanced') || text.includes('高级') || text.includes('楂樼骇') || text.includes('妤傛')) {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('.provider-action-row button')).at(-1);
  }
  if (text.includes('verify') || text.includes('验证') || text.includes('楠岃瘉') || text.includes('妤犲')) {
    return container.querySelector<HTMLButtonElement>('.provider-primary-action');
  }
  if (text.includes('model') || text.includes('模型') || text.includes('妯″瀷') || text.includes('濡')) {
    const actionButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('.provider-action-row button'));
    return actionButtons.length >= 3 ? actionButtons[actionButtons.length - 2] : actionButtons[1];
  }
  if (text.includes('濞ｈ濮為弶')) {
    return container.querySelector<HTMLButtonElement>('.provider-model-toolbar .icon-button');
  }

  return undefined;
}

function secretInput(container: HTMLElement) {
  return container.querySelector<HTMLInputElement>('.provider-secret-row input');
}

function advancedSettingsDialog(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>('.provider-advanced-modal')).find((dialog) =>
    dialog.querySelector('.provider-modal-grid') && dialog.querySelector('textarea') && dialog.querySelector('.provider-custom-header-list'),
  );
}

function modelCatalogDialog(container: HTMLElement) {
  return container.querySelector<HTMLElement>('.provider-model-modal');
}

function capabilityRegistryDialog(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>('.provider-advanced-modal')).find((dialog) =>
    dialog.querySelector('.provider-custom-header-list') && !dialog.querySelector('textarea') && !dialog.querySelector('.audio-mode-help-list'),
  );
}

function verificationDialog(container: HTMLElement) {
  return container.querySelector<HTMLElement>('.provider-validation-modal');
}

function deleteActiveProviderButton(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>('.provider-studio-header-actions .provider-header-icon-danger');
}

function deleteSceneModelButton(container: HTMLElement, modelId: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('.provider-scene-model-item .provider-header-icon-danger')).find((button) =>
    button.closest('.provider-scene-model-item')?.textContent?.includes(modelId),
  );
}

function revealSecretButton(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>('.provider-secret-row .secret-visibility-button');
}

function resetEndpointButton(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>('.provider-auth-entry-field .secret-visibility-button');
}

function addPlatformButton(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>('.provider-directory-add');
}

function directoryItems(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('.provider-directory-item'));
}

function sceneAddButtons(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('.provider-scene-card-header button'));
}

function manualModelAddButton(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>('.provider-scene-manual-row button');
}

function pendingRegistrationDialog(container: HTMLElement, modelId: string) {
  return Array.from(container.querySelectorAll<HTMLElement>('.provider-advanced-modal')).find((dialog) => dialog.textContent?.includes(modelId));
}

function modalInput(container: HTMLElement, index: number) {
  return container.querySelectorAll<HTMLInputElement>('.provider-modal input')[index];
}

async function click(element: HTMLElement | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

async function confirmPendingModelRegistration(container: HTMLElement) {
  await click(buttonByText(container, '\u767b\u8bb0\u5e76\u6dfb\u52a0'));
}

async function inputText(element: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

  await act(async () => {
    valueSetter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function selectValue(element: HTMLSelectElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;

  await act(async () => {
    valueSetter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function inputTextarea(element: HTMLTextAreaElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;

  await act(async () => {
    valueSetter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function dispatch(element: EventTarget, event: Event) {
  await act(async () => {
    element.dispatchEvent(event);
    await Promise.resolve();
  });
}

function fieldControl<T extends Element>(container: HTMLElement, label: string, selector: string) {
  return Array.from(container.querySelectorAll('label'))
    .find((field) => field.textContent?.includes(label))
    ?.querySelector<T>(selector);
}

async function waitForExpectation(assertion: () => void) {
  let lastError: unknown;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  throw lastError;
}

describe('ProvidersPage', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    invokeMock.mockReset().mockRejectedValue(new Error('runtime snapshot refresh unavailable in test'));
    getProviderSecretStatusMock.mockReset().mockResolvedValue({
      reference: appConfigDraftMock.providers[0].authRef.reference,
      backend: 'windows-credential-manager',
      hasSecret: false,
    });
    saveProviderSecretMock.mockReset().mockResolvedValue({
      reference: appConfigDraftMock.providers[0].authRef.reference,
      backend: 'windows-credential-manager',
      hasSecret: true,
    });
    readProviderSecretMock.mockReset().mockResolvedValue({
      reference: appConfigDraftMock.providers[0].authRef.reference,
      backend: 'windows-credential-manager',
      secret: 'stored-secret',
    });
    runProviderProbeMock.mockReset().mockResolvedValue({
      id: 'probe-test',
      templateId: appConfigDraftMock.providers[0].templateId,
      providerId: appConfigDraftMock.providers[0].providerId,
      verdict: 'available',
      checkedAt: '2026-05-29T08:00:00Z',
      measuredLatencyMs: 100,
      latencyBudgetMs: 1200,
      streamSupported: true,
      errorShapeStable: true,
      responseShapeStable: true,
      transportRequested: 'websocket',
      transportEffective: 'websocket',
      fallbackApplied: false,
      checks: [],
      guidance: [],
      routingDecision: { subtitlePriority: 'subtitle-first', speechDisposition: 'deferred', rationale: 'test' },
      error: null,
    });
    runProviderSmokeMock.mockReset().mockResolvedValue({
      requestId: 'smoke-test',
      status: 'completed',
      durationMs: 120,
      firstEventLatencyMs: 40,
      streamObserved: true,
      transcript: 'test completed',
      eventLog: [],
      routingDecision: { subtitlePriority: 'subtitle-first', speechDisposition: 'deferred', rationale: 'test' },
      error: null,
    });
    fetchProviderModelsMock.mockReset().mockResolvedValue({
      providerId: appConfigDraftMock.providers[0].providerId,
      endpoint: 'https://example.test/models',
      fetchedAt: '2026-05-29T08:00:00Z',
      models: [
        {
          id: 'qwen-extra-live',
          displayName: 'qwen-extra-live',
          ownedBy: 'dashscope',
          createdAt: null,
          capabilities: ['speech-to-text'],
          providerTemplateId: appConfigDraftMock.providers[0].templateId,
          providerTemplateName: appConfigDraftMock.providers[0].displayName,
        },
        { id: 'qwen-plus', displayName: 'qwen-plus', ownedBy: 'dashscope', createdAt: null, capabilities: ['text-generation'] },
      ],
      error: null,
    });
    setTauriRuntime(false);
    window.localStorage.removeItem('omni.customProviderTemplates');
    window.localStorage.removeItem('omni.providerTemplateCatalogPrefs');

    const { configDraft, runtimeSnapshot, audioRuntimeSnapshot } = cloneStoreState();
    useAppStore.setState((state) => ({
      ...state,
      configDraft,
      runtimeSnapshot,
      audioRuntimeSnapshot,
      runtimeNotifications: runtimeSnapshot.notifications,
    }));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    setTauriRuntime(false);
    window.localStorage.removeItem('omni.customProviderTemplates');
    window.localStorage.removeItem('omni.providerTemplateCatalogPrefs');
    vi.useRealTimers();
  });

  async function renderPage() {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <ProvidersPage />
        </MemoryRouter>,
      );
      await Promise.resolve();
    });
  }

  it('renders provider directory, auth controls, and scene model cards', async () => {
    await renderPage();

    expect(container.querySelector('.provider-directory')).not.toBeNull();
    expect(directoryItems(container).length).toBeGreaterThan(2);
    expect(secretInput(container)).not.toBeNull();
    expect(sceneAddButtons(container)).toHaveLength(4);
    expect(container.textContent).toContain(appConfigDraftMock.providers[0].displayName);
  });

  it('falls back when active provider metadata is stale', async () => {
    const state = cloneStoreState();
    state.configDraft.activeProviderTemplateId = 'missing-active-template';
    state.configDraft.providers[0].localModelCapabilityRegistry = undefined as never;
    useAppStore.setState((current) => ({ ...current, ...state }));

    await renderPage();

    expect(container.querySelector('.provider-directory')).not.toBeNull();
    expect(secretInput(container)).not.toBeNull();
  });

  it('falls back to the default template when the provider template is unknown', async () => {
    const state = cloneStoreState();
    state.configDraft.activeProviderTemplateId = 'unknown-provider-template';
    state.configDraft.providers[0] = {
      ...state.configDraft.providers[0],
      templateId: 'unknown-provider-template',
      localModelCapabilityRegistry: undefined as never,
    };
    useAppStore.setState((current) => ({ ...current, ...state }));

    await renderPage();

    expect(container.querySelector('.provider-studio-header')).not.toBeNull();
    expect(secretInput(container)).not.toBeNull();
  });

  it('blocks secret saving until desktop storage is ready', async () => {
    setTauriRuntime(true);
    const { configDraft, runtimeSnapshot, audioRuntimeSnapshot } = cloneStoreState();
    runtimeSnapshot.bridgeStatus = 'browser-preview';
    runtimeSnapshot.storage.status = 'preview';
    useAppStore.setState((state) => ({
      ...state,
      configDraft,
      runtimeSnapshot,
      audioRuntimeSnapshot,
      runtimeNotifications: runtimeSnapshot.notifications,
    }));

    await renderPage();
    await inputText(secretInput(container)!, 'dashscope-secret');

    const saveButton = container.querySelector<HTMLButtonElement>('.provider-auth-entry-actions .action-button');
    expect(saveButton?.disabled).toBe(true);
    expect(saveProviderSecretMock).not.toHaveBeenCalled();
  });

  it('surfaces runtime errors and blocks model catalog refresh work', async () => {
    setTauriRuntime(true);
    const { configDraft, runtimeSnapshot, audioRuntimeSnapshot } = cloneStoreState();
    runtimeSnapshot.bridgeStatus = 'runtime-error';
    runtimeSnapshot.storage.status = 'preview';
    runtimeSnapshot.storage.credentialBackend = 'windows-credential-manager';
    const runtimeNotifications = [
      {
        id: 'runtime-error',
        level: 'error' as const,
        source: 'runtime',
        message: 'runtime failed',
        emittedAt: '2026-06-07T00:00:00.000Z',
      },
    ];
    useAppStore.setState((state) => ({
      ...state,
      configDraft,
      runtimeSnapshot,
      audioRuntimeSnapshot,
      runtimeNotifications,
    }));

    await renderPage();
    expect(container.textContent).toContain('runtime failed');
    expect(buttonContainingText(container, '妤犲矁鐦夐幒銉ュ弳')?.disabled).toBe(true);

    await click(Array.from(container.querySelectorAll<HTMLButtonElement>('.provider-action-row button')).at(-2));
    expect(modelCatalogDialog(container)).not.toBeNull();
    expect(fetchProviderModelsMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('runtime failed');
  });

  it('saves provider secret when desktop storage is ready', async () => {
    setTauriRuntime(true);
    const { configDraft, runtimeSnapshot, audioRuntimeSnapshot } = cloneStoreState();
    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    runtimeSnapshot.storage.status = 'ready';
    useAppStore.setState((state) => ({
      ...state,
      configDraft,
      runtimeSnapshot,
      audioRuntimeSnapshot,
      runtimeNotifications: runtimeSnapshot.notifications,
    }));

    await renderPage();
    await inputText(secretInput(container)!, 'dashscope-secret');
    await click(container.querySelector<HTMLButtonElement>('.provider-auth-entry-actions .action-button'));

    expect(getProviderSecretStatusMock).toHaveBeenCalledWith(configDraft.providers[0].authRef.reference);
    expect(saveProviderSecretMock).toHaveBeenCalledWith(configDraft.providers[0].authRef.reference, 'dashscope-secret');
  });

  it('switches active provider from the directory', async () => {
    await renderPage();

    await click(directoryItems(container).find((item) => item.textContent?.includes('DeepSeek')));

    expect(useAppStore.getState().configDraft.activeProviderTemplateId).toBe('template-deepseek');
    expect(container.querySelector('.provider-directory-item-active')?.textContent).toContain('DeepSeek');
  });

  it('keeps the current provider when applying the already active directory entry', async () => {
    await renderPage();

    const activeTemplateId = useAppStore.getState().configDraft.activeProviderTemplateId;
    await click(container.querySelector<HTMLButtonElement>('.provider-directory-item-active'));

    expect(useAppStore.getState().configDraft.activeProviderTemplateId).toBe(activeTemplateId);
  });

  it('restores cached scene assignments when switching back to a provider template', async () => {
    const state = cloneStoreState();
    state.configDraft.providers[0].sceneModelAssignments = [
      { scenario: 'watch', modelIds: ['cached-watch-model'] },
      { scenario: 'game', modelIds: ['cached-game-model'] },
      { scenario: 'voice-room', modelIds: [] },
      { scenario: 'subtitle-translate', modelIds: [] },
    ];
    useAppStore.setState((current) => ({ ...current, ...state }));

    await renderPage();

    const originalTemplateId = useAppStore.getState().configDraft.activeProviderTemplateId;
    await click(directoryItems(container).find((item) => item.textContent?.includes('DeepSeek')));
    expect(useAppStore.getState().configDraft.activeProviderTemplateId).not.toBe(originalTemplateId);

    await click(directoryItems(container)[1]);

    const restored = useAppStore.getState().configDraft.providers.find((provider) => provider.templateId === originalTemplateId);
    expect(restored?.sceneModelAssignments.find((item) => item.scenario === 'watch')?.modelIds).toContain('cached-watch-model');
    expect(restored?.sceneModelAssignments.find((item) => item.scenario === 'game')?.modelIds).toContain('cached-game-model');
  });

  it('creates a custom provider and switches to it', async () => {
    await renderPage();

    await click(addPlatformButton(container));
    await inputText(modalInput(container, 0), 'OpenRouter Custom');
    await inputText(modalInput(container, 1), 'https://openrouter.ai/api/v1');
    await click(buttonByText(container, '閸掓稑缂撻獮鍐插酱'));

    const created = useAppStore.getState().configDraft.providers.find(
      (p) => p.templateId === useAppStore.getState().configDraft.activeProviderTemplateId,
    );
    expect(created?.displayName).toBe('OpenRouter Custom');
    expect(created?.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('persists custom template updates after editing the active custom provider', async () => {
    await renderPage();

    await click(addPlatformButton(container));
    await inputText(modalInput(container, 0), 'Editable Custom');
    await inputText(modalInput(container, 1), 'https://editable.example/v1');
    await click(buttonByText(container, '閸掓稑缂撻獮鍐插酱'));

    await click(buttonContainingText(container, '妤傛楠囩拋鍓х枂'));
    const dialog = advancedSettingsDialog(container)!;
    await inputText(dialog.querySelector<HTMLInputElement>('.provider-modal-grid input')!, 'Editable Custom Updated');

    await waitForExpectation(() => {
      expect(window.localStorage.getItem('omni.customProviderTemplates')).toContain('Editable Custom Updated');
    });
  });

  it('updates only the active custom template when multiple custom providers exist', async () => {
    await renderPage();

    await click(addPlatformButton(container));
    await inputText(modalInput(container, 0), 'First Custom');
    await inputText(modalInput(container, 1), 'https://first.example/v1');
    await click(buttonByText(container, '閸掓稑缂撻獮鍐插酱'));

    await click(addPlatformButton(container));
    await inputText(modalInput(container, 0), 'Second Custom');
    await inputText(modalInput(container, 1), 'https://second.example/v1');
    await click(buttonByText(container, '閸掓稑缂撻獮鍐插酱'));

    await click(buttonContainingText(container, '妤傛楠囩拋鍓х枂'));
    const dialog = advancedSettingsDialog(container)!;
    await inputText(dialog.querySelector<HTMLInputElement>('.provider-modal-grid input')!, 'Second Custom Updated');

    await waitForExpectation(() => {
      const saved = window.localStorage.getItem('omni.customProviderTemplates') ?? '';
      expect(saved).toContain('First Custom');
      expect(saved).toContain('Second Custom Updated');
      expect(saved).not.toContain('First Custom Updated');
    });
  });

  it('adds a manual model id to the selected scene', async () => {
    await renderPage();

    await click(sceneAddButtons(container)[0]);
    await inputText(container.querySelector<HTMLInputElement>('.provider-scene-manual-row input')!, 'manual-scene-model');
    await click(buttonByText(container, '閹靛濮╁ǎ璇插'));
    expect(pendingRegistrationDialog(container, 'manual-scene-model')).toBeTruthy();
    await confirmPendingModelRegistration(container);

    expect(useAppStore.getState().configDraft.providers[0].sceneModelAssignments[0]?.modelIds).toContain('manual-scene-model');
    expect(useAppStore.getState().configDraft.providers[0].localModelCapabilityRegistry[0]).toMatchObject({
      modelId: 'manual-scene-model',
      realtimeAudioMode: 'server_vad',
    });
    expect(container.textContent).toContain('manual-scene-model');
  });

  it('refreshes model catalog and adds a runtime model to a scene', async () => {
    setTauriRuntime(true);
    const { configDraft, runtimeSnapshot, audioRuntimeSnapshot } = cloneStoreState();
    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    runtimeSnapshot.storage.status = 'ready';
    configDraft.providers[0].model = 'qwen-extra-live';
    configDraft.providers[0].localModelCapabilityRegistry = [
      ...configDraft.providers[0].localModelCapabilityRegistry,
      { id: 'registry-qwen-extra-live', modelId: 'qwen-extra-live', capabilities: ['speech-to-text'] },
    ];
    configDraft.providers[0].modelCatalogCache = {
      signature: '',
      source: 'runtime',
      fetchedAt: '2026-05-29T08:00:00Z',
      endpoint: 'https://example.test/models',
      models: [
        {
          id: 'qwen-extra-live',
          displayName: 'qwen-extra-live',
          ownedBy: 'dashscope',
          createdAt: null,
          capabilities: ['speech-to-text'],
          providerTemplateId: configDraft.providers[0].templateId,
          providerTemplateName: configDraft.providers[0].displayName,
        },
      ],
      error: null,
    };
    useAppStore.setState((state) => ({
      ...state,
      configDraft,
      runtimeSnapshot,
      audioRuntimeSnapshot,
      runtimeNotifications: runtimeSnapshot.notifications,
    }));

    await renderPage();
    await click(sceneAddButtons(container)[0]);

    expect(fetchProviderModelsMock).toHaveBeenCalled();
    expect(modelCatalogDialog(container)).not.toBeNull();
    await waitForExpectation(() => expect(container.textContent).toContain('qwen-extra-live'));

    const modelRow = Array.from(container.querySelectorAll<HTMLElement>('.provider-model-item')).find((item) => item.textContent?.includes('qwen-extra-live'));
    await click(modelRow!.querySelector<HTMLButtonElement>('.provider-row-action'));

    expect(useAppStore.getState().configDraft.providers[0].sceneModelAssignments[0]?.modelIds).toContain('qwen-extra-live');
  });

  it('updates provider advanced settings', async () => {
    await renderPage();

    await click(buttonContainingText(container, '妤傛楠囩拋鍓х枂'));
    const dialog = advancedSettingsDialog(container);
    expect(dialog).not.toBeNull();

    const apiFormatSelect = Array.from(dialog!.querySelectorAll<HTMLSelectElement>('select')).find((select) =>
      Array.from(select.options).some((option) => option.value === 'openai-compatible'),
    );
    expect(apiFormatSelect).toBeDefined();
    await selectValue(apiFormatSelect!, 'openai-compatible');

    const baseUrlInput = Array.from(dialog!.querySelectorAll<HTMLInputElement>('input')).find((input) => input.value.includes('/v1'));
    expect(baseUrlInput).toBeDefined();
    await inputText(baseUrlInput!, 'https://api.deepseek.com/v1');

    expect(useAppStore.getState().configDraft.providers[0].kind).toBe('openai-compatible');
    expect(useAppStore.getState().configDraft.providers[0].baseUrl).toBe('https://api.deepseek.com/v1');
  });

  it('runs provider verification and opens validation details', async () => {
    await renderPage();

    await click(buttonContainingText(container, '妤犲矁鐦夐幒銉ュ弳'));

    expect(runProviderProbeMock).toHaveBeenCalled();
    expect(runProviderSmokeMock).toHaveBeenCalled();
    expect(verificationDialog(container)).not.toBeNull();
  });

  it('deletes the active custom provider and returns to a built-in template', async () => {
    await renderPage();
    await click(addPlatformButton(container));
    await inputText(modalInput(container, 0), 'Temporary Custom');
    await inputText(modalInput(container, 1), 'https://custom.example/v1');
    await click(buttonByText(container, '閸掓稑缂撻獮鍐插酱'));

    const customTemplateId = useAppStore.getState().configDraft.activeProviderTemplateId;
    expect(customTemplateId).toContain('template-custom-temporary-custom-');
    await click(deleteActiveProviderButton(container));

    expect(useAppStore.getState().configDraft.activeProviderTemplateId).not.toBe(customTemplateId);
    expect(useAppStore.getState().configDraft.providers.some((provider) => provider.templateId === customTemplateId)).toBe(
      false,
    );
  });

  it('removes a manually added scene model', async () => {
    await renderPage();
    await click(sceneAddButtons(container)[0]);
    await inputText(container.querySelector<HTMLInputElement>('.provider-scene-manual-row input')!, 'remove-me');
    await click(buttonByText(container, '閹靛濮╁ǎ璇插'));
    await confirmPendingModelRegistration(container);
    expect(useAppStore.getState().configDraft.providers[0].sceneModelAssignments[0]?.modelIds).toContain('remove-me');

    await click(deleteSceneModelButton(container, 'remove-me'));
    expect(useAppStore.getState().configDraft.providers[0].sceneModelAssignments[0]?.modelIds).not.toContain('remove-me');
  });

  it('adds, edits, disables and deletes a custom request header', async () => {
    await renderPage();
    await click(Array.from(container.querySelectorAll<HTMLButtonElement>('.provider-action-row button')).at(-1));
    const dialog = Array.from(container.querySelectorAll<HTMLElement>('.provider-advanced-modal')).find((item) =>
      item.querySelector('.provider-custom-header-list') && item.querySelector('textarea'),
    )!;
    await click(Array.from(dialog.querySelectorAll<HTMLButtonElement>('.provider-setting-header .icon-button')).at(-1));
    const header = dialog.querySelector<HTMLElement>('.provider-custom-header-item')!;
    const inputs = header.querySelectorAll<HTMLInputElement>('input');
    await inputText(inputs[0], 'X-Test');
    await inputText(inputs[1], 'header-value');
    await selectValue(header.querySelector<HTMLSelectElement>('select')!, 'false');
    expect(useAppStore.getState().configDraft.providers[0].customHeaders[0]).toMatchObject({
      name: 'X-Test',
      value: 'header-value',
      enabled: false,
    });

    await click(header.querySelector<HTMLButtonElement>('.provider-header-icon-danger'));
    expect(useAppStore.getState().configDraft.providers[0].customHeaders).toEqual([]);
  });

  it('adds, toggles and removes a local model capability registry entry', async () => {
    await renderPage();
    await click(sceneAddButtons(container)[0]);
    await click(container.querySelector<HTMLButtonElement>('.provider-model-toolbar .provider-header-icon'));
    const dialog = capabilityRegistryDialog(container)!;
    await click(buttonContainingText(dialog, '濞ｈ濮為弶锛勬窗'));

    const entry = dialog.querySelector<HTMLElement>('.provider-capability-registry-item')!;
    await inputText(entry.querySelector<HTMLInputElement>('input')!, 'custom-asr-model');
    await selectValue(entry.querySelector<HTMLSelectElement>('.provider-capability-mode-select')!, 'semantic_vad');
    await click(entry.querySelector<HTMLButtonElement>('.provider-capability-chip') ?? entry.querySelector('button'));
    expect(useAppStore.getState().configDraft.providers[0].localModelCapabilityRegistry.some((item) => item.modelId === 'custom-asr-model')).toBe(
      true,
    );
    expect(
      useAppStore.getState().configDraft.providers[0].localModelCapabilityRegistry.find((item) => item.modelId === 'custom-asr-model')
        ?.realtimeAudioMode,
    ).toBe('semantic_vad');

    await click(entry.querySelector<HTMLButtonElement>('.provider-header-icon-danger'));
    expect(useAppStore.getState().configDraft.providers[0].localModelCapabilityRegistry.some((item) => item.modelId === 'custom-asr-model')).toBe(
      false,
    );
  });

  it('edits the auth endpoint and reveals then hides the stored secret', async () => {
    setTauriRuntime(true);
    const { configDraft, runtimeSnapshot, audioRuntimeSnapshot } = cloneStoreState();
    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    runtimeSnapshot.storage.status = 'ready';
    useAppStore.setState((state) => ({
      ...state,
      configDraft,
      runtimeSnapshot,
      audioRuntimeSnapshot,
      runtimeNotifications: runtimeSnapshot.notifications,
    }));

    await renderPage();
    const endpointInput = container.querySelector<HTMLInputElement>('.provider-auth-entry-field input')!;
    await inputText(endpointInput, 'https://temporary.example/v1');
    expect(useAppStore.getState().configDraft.providers[0].baseUrl).toBe('https://temporary.example/v1');

    await click(resetEndpointButton(container));
    expect(useAppStore.getState().configDraft.providers[0].baseUrl).toBe(appConfigDraftMock.providers[0].baseUrl);

    await click(revealSecretButton(container));
    expect(readProviderSecretMock).toHaveBeenCalled();
    expect(secretInput(container)?.type).toBe('text');
    await click(revealSecretButton(container));
    expect(secretInput(container)?.type).toBe('password');
  });

  it('filters, toggles and mouse-drags provider directory entries', async () => {
    await renderPage();
    const query = container.querySelector<HTMLInputElement>('.provider-directory-search-input')!;
    const initialCount = directoryItems(container).length;
    await inputText(query, 'deepseek');
    expect(directoryItems(container).length).toBeLessThan(initialCount);
    await inputText(query, 'no-provider-template-match');
    expect(container.querySelector('.provider-directory-empty')).not.toBeNull();
    await inputText(query, '');

    const first = directoryItems(container)[0];
    const second = directoryItems(container)[1];
    await click(first.querySelector<HTMLElement>('.provider-directory-item-state'));
    expect(window.localStorage.getItem('omni.providerTemplateCatalogPrefs')).toContain('"enabled":false');

    await dispatch(first, new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    await dispatch(second, new MouseEvent('mouseover', { bubbles: true, buttons: 1, clientX: 30, clientY: 30 }));
    await dispatch(second, new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    await dispatch(window, new MouseEvent('mouseup', { bubbles: true }));
    expect(window.localStorage.getItem('omni.providerTemplateCatalogPrefs')).toContain('"order":');
  });

  it('updates advanced provider fields, response modalities and closes the dialog', async () => {
    await renderPage();
    await click(buttonContainingText(container, '妤傛楠囩拋鍓х枂'));
    const dialog = advancedSettingsDialog(container)!;
    const inputs = dialog.querySelectorAll<HTMLInputElement>('.provider-modal-grid input');
    const selects = dialog.querySelectorAll<HTMLSelectElement>('.provider-modal-grid select');

    await inputText(inputs[0], 'DashScope Edited');
    await selectValue(selects[0], 'dashscope');
    const dashscopeInputs = dialog.querySelectorAll<HTMLInputElement>('.provider-modal-grid input');
    const dashscopeSelects = dialog.querySelectorAll<HTMLSelectElement>('.provider-modal-grid select');
    await selectValue(dashscopeSelects[1], 'http');
    await inputText(dashscopeInputs[2], '22000');
    await selectValue(dashscopeSelects[2], 'api-key');
    await inputText(dashscopeInputs[3], 'X-API-Key');
    await selectValue(dashscopeSelects[3], 'false');
    await inputText(dashscopeInputs[4], '0.6');
    await inputText(dashscopeInputs[5], '1024');
    await inputTextarea(dialog.querySelector<HTMLTextAreaElement>('textarea')!, 'translate this sample');
    await click(Array.from(dialog.querySelectorAll<HTMLButtonElement>('.provider-scenario-pill')).at(-1));

    expect(useAppStore.getState().configDraft.providers[0]).toMatchObject({
      displayName: 'DashScope Edited',
      kind: 'dashscope',
      transport: 'http',
      timeoutMs: 22000,
      streamEnabled: false,
      temperature: 0.6,
      maxOutputTokens: 1024,
    });
    expect(useAppStore.getState().configDraft.providers[0].authRef).toMatchObject({
      scheme: 'api-key',
      headerName: 'X-API-Key',
    });
    expect(useAppStore.getState().configDraft.providers[0].responseModalities).toContain('audio');

    await click(dialog.querySelector<HTMLButtonElement>('.provider-panel-heading .provider-header-icon'));
    expect(advancedSettingsDialog(container)).toBeUndefined();
  });

  it('updates custom provider kind-specific controls before closing the dialog', async () => {
    await renderPage();
    await click(addPlatformButton(container));
    const dialog = container.querySelector<HTMLElement>('.provider-modal')!;
    const selects = dialog.querySelectorAll<HTMLSelectElement>('select');

    await selectValue(selects[0], 'dashscope');
    await selectValue(selects[1], 'http');
    await inputText(dialog.querySelector<HTMLInputElement>('input[placeholder="Authorization"]')!, 'X-DashScope-Key');
    await selectValue(selects[2], 'api-key');
    await inputText(dialog.querySelector<HTMLInputElement>('input[placeholder="cn-beijing"]')!, 'cn-shanghai');
    await inputText(dialog.querySelector<HTMLInputElement>('input[type="number"]')!, '23000');

    expect(dialog.querySelector<HTMLInputElement>('input[placeholder="cn-beijing"]')?.value).toBe('cn-shanghai');
    await click(Array.from(dialog.querySelectorAll<HTMLButtonElement>('.provider-modal-actions button')).at(0));
    expect(container.querySelector('.provider-modal')).toBeNull();
  });

  it('keeps supported transport and applies default DashScope region when switching API kind', async () => {
    const state = cloneStoreState();
    state.configDraft.providers[0].kind = 'openai-compatible';
    state.configDraft.providers[0].transport = 'http';
    state.configDraft.providers[0].region = undefined;
    useAppStore.setState((current) => ({ ...current, ...state }));

    await renderPage();
    await click(buttonContainingText(container, '妤傛楠囩拋鍓х枂'));
    const dialog = advancedSettingsDialog(container)!;
    const apiFormatSelect = Array.from(dialog.querySelectorAll<HTMLSelectElement>('select')).find((select) =>
      Array.from(select.options).some((option) => option.value === 'dashscope'),
    )!;

    await selectValue(apiFormatSelect, 'dashscope');

    expect(useAppStore.getState().configDraft.providers[0]).toMatchObject({
      kind: 'dashscope',
      transport: 'http',
      region: 'cn-beijing',
    });
  });

  it('filters, refreshes and closes the model catalog', async () => {
    await renderPage();
    await click(sceneAddButtons(container)[0]);
    const dialog = modelCatalogDialog(container)!;

    await click(Array.from(dialog.querySelectorAll<HTMLButtonElement>('.provider-model-toolbar .provider-header-icon')).at(1));
    await inputText(dialog.querySelector<HTMLInputElement>('.provider-directory-search-input')!, 'qwen-plus');
    await click(Array.from(dialog.querySelectorAll<HTMLButtonElement>('.provider-scenario-pill')).at(-1));
    await dispatch(dialog, new MouseEvent('click', { bubbles: true }));
    expect(modelCatalogDialog(container)).not.toBeNull();

    await click(Array.from(dialog.querySelectorAll<HTMLButtonElement>('.provider-model-toolbar .provider-header-icon')).at(-1));
    expect(modelCatalogDialog(container)).toBeNull();
  });

  it('filters catalog models when owner metadata is absent', async () => {
    const state = cloneStoreState();
    const ownerlessModels = [
      {
        id: 'ownerless-runtime-model',
        displayName: 'Ownerless Runtime Model',
        ownedBy: null,
        createdAt: null,
        capabilities: ['speech-to-text'],
        providerTemplateId: state.configDraft.providers[0].templateId,
        providerTemplateName: state.configDraft.providers[0].displayName,
      },
    ];
    fetchProviderModelsMock.mockResolvedValueOnce({
      providerId: state.configDraft.providers[0].providerId,
      endpoint: 'https://example.test/models',
      fetchedAt: '2026-06-07T00:00:00.000Z',
      error: null,
      models: ownerlessModels,
    });
    useAppStore.setState((current) => ({ ...current, ...state }));

    await renderPage();
    await click(Array.from(container.querySelectorAll<HTMLButtonElement>('.provider-action-row button')).at(-2));
    const dialog = modelCatalogDialog(container)!;
    await waitForExpectation(() => expect(dialog.textContent).toContain('Ownerless Runtime Model'));
    await inputText(dialog.querySelector<HTMLInputElement>('.provider-directory-search-input')!, 'speech-to-text');

    expect(dialog.textContent).toContain('Ownerless Runtime Model');
  });

  it('uses all-model catalog toggles to remove and register models', async () => {
    setTauriRuntime(true);
    const state = cloneStoreState();
    state.runtimeSnapshot.bridgeStatus = 'tauri-shell';
    state.runtimeSnapshot.storage.status = 'ready';
    state.configDraft.providers[0].modelCatalogCache = {
      signature: providersPageHelpers.buildModelCatalogSignature(state.configDraft.providers[0]),
      source: 'runtime',
      fetchedAt: '2026-06-07T00:00:00.000Z',
      endpoint: 'https://example.test/models',
      error: null,
      models: [
        {
          id: 'qwen3.5-omni-plus-realtime',
          displayName: 'Qwen Realtime',
          ownedBy: null,
          createdAt: null,
          capabilities: ['speech-to-text'],
          providerTemplateId: state.configDraft.providers[0].templateId,
          providerTemplateName: state.configDraft.providers[0].displayName,
        },
        {
          id: 'uncategorized-runtime-model',
          displayName: 'Uncategorized Runtime Model',
          ownedBy: null,
          createdAt: null,
          capabilities: [],
          providerTemplateId: state.configDraft.providers[0].templateId,
          providerTemplateName: state.configDraft.providers[0].displayName,
        },
      ],
    };
    fetchProviderModelsMock.mockResolvedValueOnce({
      providerId: state.configDraft.providers[0].providerId,
      endpoint: 'https://example.test/models',
      fetchedAt: '2026-06-07T00:00:00.000Z',
      error: null,
      models: state.configDraft.providers[0].modelCatalogCache.models,
    });
    useAppStore.setState((current) => ({ ...current, ...state, runtimeNotifications: state.runtimeSnapshot.notifications }));

    await renderPage();
    await click(Array.from(container.querySelectorAll<HTMLButtonElement>('.provider-action-row button')).at(-2));
    const dialog = modelCatalogDialog(container)!;
    const existingRow = Array.from(dialog.querySelectorAll<HTMLElement>('.provider-model-item')).find((item) => item.textContent?.includes('qwen3.5-omni-plus-realtime'))!;
    await click(existingRow.querySelector<HTMLButtonElement>('.provider-row-action'));
    expect(useAppStore.getState().configDraft.providers[0].sceneModelAssignments[0]?.modelIds).not.toContain('qwen3.5-omni-plus-realtime');

    const uncategorizedRow = Array.from(dialog.querySelectorAll<HTMLElement>('.provider-model-item')).find((item) => item.textContent?.includes('uncategorized-runtime-model'))!;
    await click(uncategorizedRow.querySelector<HTMLButtonElement>('.provider-row-action'));
    expect(pendingRegistrationDialog(container, 'uncategorized-runtime-model')).toBeTruthy();
    await click(pendingRegistrationDialog(container, 'uncategorized-runtime-model')?.querySelector<HTMLButtonElement>('.provider-header-icon'));
    expect(pendingRegistrationDialog(container, 'uncategorized-runtime-model')).toBeUndefined();
  });

  it('marks models as added across all catalog scenarios without changing the target scenario', async () => {
    const state = cloneStoreState();
    state.configDraft.devices.routeMode = 'watch';
    state.configDraft.providers[0].sceneModelAssignments = [
      { scenario: 'watch', modelIds: [] },
      { scenario: 'game', modelIds: ['qwen-plus'] },
      { scenario: 'voice-room', modelIds: [] },
      { scenario: 'subtitle-translate', modelIds: [] },
    ];
    state.configDraft.providers[0].modelCatalogCache = {
      signature: providersPageHelpers.buildModelCatalogSignature(state.configDraft.providers[0]),
      source: 'runtime',
      fetchedAt: '2026-06-07T00:00:00.000Z',
      endpoint: 'https://example.test/models',
      error: null,
      models: [
        {
          id: 'qwen-plus',
          displayName: 'qwen-plus',
          ownedBy: null,
          createdAt: null,
          capabilities: ['text-generation'],
          providerTemplateId: state.configDraft.providers[0].templateId,
          providerTemplateName: state.configDraft.providers[0].displayName,
        },
      ],
    };
    useAppStore.setState((current) => ({ ...current, ...state }));

    await renderPage();
    await click(Array.from(container.querySelectorAll<HTMLButtonElement>('.provider-action-row button')).at(-2));
    const dialog = modelCatalogDialog(container)!;
    await click(dialog.querySelector<HTMLButtonElement>('.provider-scenario-pill'));

    const row = Array.from(dialog.querySelectorAll<HTMLElement>('.provider-model-item')).find((item) => item.textContent?.includes('qwen-plus'))!;
    expect(row.classList.contains('provider-model-item-active')).toBe(true);

    await click(row.querySelector<HTMLButtonElement>('.provider-row-action'));
    const assignments = useAppStore.getState().configDraft.providers[0].sceneModelAssignments;
    expect(assignments.find((item) => item.scenario === 'watch')?.modelIds).toContain('qwen-plus');
    expect(assignments.find((item) => item.scenario === 'game')?.modelIds).toContain('qwen-plus');
  });

  it('closes capability registry and verification dialogs through their close controls', async () => {
    await renderPage();
    await click(sceneAddButtons(container)[0]);
    await click(container.querySelector<HTMLButtonElement>('.provider-model-toolbar .provider-header-icon'));
    await click(capabilityRegistryDialog(container)?.querySelector<HTMLButtonElement>('.provider-model-toolbar .provider-header-icon:last-child'));
    expect(capabilityRegistryDialog(container)).toBeUndefined();

    await click(Array.from(modelCatalogDialog(container)!.querySelectorAll<HTMLButtonElement>('.provider-model-toolbar .provider-header-icon')).at(-1));
    await click(buttonContainingText(container, '妤犲矁鐦夐幒銉ュ弳'));
    await click(Array.from(container.querySelectorAll<HTMLButtonElement>('.provider-action-row button')).at(1));
    await click(verificationDialog(container)?.querySelector<HTMLButtonElement>('.provider-model-toolbar .provider-header-icon'));
    expect(verificationDialog(container)).toBeNull();
  });

  it('shows validation failures, guidance and smoke event logs', async () => {
    runProviderProbeMock.mockResolvedValue({
      ...await runProviderProbeMock(),
      verdict: 'unavailable',
      streamSupported: false,
      fallbackApplied: true,
      guidance: ['check endpoint'],
      error: { code: 'probe.failed', message: 'probe denied', suggestion: 'retry later' },
    });
    runProviderSmokeMock.mockResolvedValue({
      ...await runProviderSmokeMock(),
      status: 'failed',
      firstEventLatencyMs: null,
      streamObserved: false,
      transcript: '',
      error: { code: 'smoke.failed', message: 'smoke denied' },
      eventLog: [{ eventType: 'error', summary: 'request rejected' }],
    });
    await renderPage();

    await click(buttonContainingText(container, '妤犲矁鐦夐幒銉ュ弳'));

    expect(container.textContent).toContain('probe denied');
    expect(container.textContent).toContain('check endpoint');
    expect(container.textContent).toContain('retry later');

    await click(verificationDialog(container)?.querySelector<HTMLButtonElement>('.provider-model-toolbar .provider-header-icon'));
    runProviderProbeMock.mockResolvedValue({
      ...await runProviderProbeMock(),
      verdict: 'available',
      error: null,
      guidance: [],
    });
    await click(buttonContainingText(container, '妤犲矁鐦夐幒銉ュ弳'));

    expect(container.textContent).toContain('smoke denied');
    expect(container.textContent).toContain('request rejected');
    expect(useAppStore.getState().configDraft.providers[0].status).toBe('warning');
  });

  it('marks provider verification warning when probe throws', async () => {
    runProviderProbeMock.mockRejectedValue('probe unavailable');
    await renderPage();

    await click(buttonContainingText(container, '妤犲矁鐦夐幒銉ュ弳'));

    expect(useAppStore.getState().configDraft.providers[0].status).toBe('warning');
  });

  it('marks provider verification warning when smoke completes without streaming', async () => {
    runProviderSmokeMock.mockResolvedValue({
      ...await runProviderSmokeMock(),
      streamObserved: false,
      status: 'completed',
      error: null,
    });
    await renderPage();

    await click(buttonContainingText(container, '妤犲矁鐦夐幒銉ュ弳'));

    expect(useAppStore.getState().configDraft.providers[0].status).toBe('warning');
    expect(useAppStore.getState().configDraft.diagnostics.providerStatus).toBe('warning');
  });

  it('shows empty runtime catalog errors and closes the catalog through its backdrop', async () => {
    fetchProviderModelsMock.mockResolvedValue({
      providerId: appConfigDraftMock.providers[0].providerId,
      endpoint: 'https://example.test/models',
      fetchedAt: '2026-05-29T08:00:00Z',
      models: [],
      error: null,
    });
    await renderPage();
    await click(sceneAddButtons(container)[0]);

    await waitForExpectation(() => expect(fetchProviderModelsMock).toHaveBeenCalled());
    await click(container.querySelector<HTMLElement>('.provider-modal-backdrop'));
    expect(modelCatalogDialog(container)).toBeNull();
  });

  it('validates missing custom provider name and base URL', async () => {
    await renderPage();
    await click(addPlatformButton(container));
    await click(buttonByText(container, '閸掓稑缂撻獮鍐插酱'));
    expect(container.textContent).toContain('平台名称不能为空');

    await inputText(modalInput(container, 0), 'Incomplete Provider');
    await inputText(modalInput(container, 1), '');
    await click(buttonByText(container, '閸掓稑缂撻獮鍐插酱'));
    expect(container.textContent).toContain('接口地址不能为空');
  });

  it('edits DashScope region, zero-value fallbacks and closes advanced settings through the backdrop', async () => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        providers: state.configDraft.providers.map((provider) =>
          provider.templateId === state.configDraft.activeProviderTemplateId
            ? { ...provider, kind: 'dashscope', region: 'cn-beijing' }
            : provider,
        ),
      },
    }));
    await renderPage();
    await click(Array.from(container.querySelectorAll<HTMLButtonElement>('.provider-action-row button')).at(-1));
    const dialog = Array.from(container.querySelectorAll<HTMLElement>('.provider-advanced-modal')).find((item) =>
      item.querySelector('.provider-custom-header-list') && item.querySelector('textarea'),
    )!;
    const numberInputs = Array.from(dialog.querySelectorAll<HTMLInputElement>('input[type="number"]'));
    await inputText(numberInputs[0]!, '');
    await inputText(fieldControl<HTMLInputElement>(dialog, 'Temperature', 'input')!, '');
    await inputText(fieldControl<HTMLInputElement>(dialog, 'Max Output Tokens', 'input')!, '');
    await selectValue(dialog.querySelector<HTMLSelectElement>('select')!, 'dashscope');
    await inputText(Array.from(dialog.querySelectorAll<HTMLInputElement>('input.text-input')).at(-1)!, 'cn-shanghai');

    expect(useAppStore.getState().configDraft.providers[0]).toMatchObject({
      timeoutMs: 0,
      temperature: 0,
      maxOutputTokens: 1,
      region: 'cn-shanghai',
    });
    await click(container.querySelector<HTMLElement>('.provider-modal-backdrop'));
    expect(advancedSettingsDialog(container)).toBeUndefined();
  });

  it('filters the catalog by scene capability', async () => {
    await renderPage();
    await click(sceneAddButtons(container)[0]);
    const dialog = modelCatalogDialog(container)!;
    await click(Array.from(dialog.querySelectorAll<HTMLButtonElement>('.provider-scenario-pill')).at(-1));
    expect(dialog.textContent).toContain('字幕翻译');
  });

  it('covers directory empty state and ignored pointer drag inputs', async () => {
    await renderPage();
    const first = directoryItems(container)[0];
    const second = directoryItems(container)[1];
    await dispatch(first, new MouseEvent('mousedown', { bubbles: true, button: 1 }));
    await dispatch(second, new MouseEvent('mouseover', { bubbles: true, buttons: 0 }));
    await inputText(container.querySelector<HTMLInputElement>('.provider-directory-search-input')!, 'no-provider-matches');
    expect(container.querySelector('.provider-directory-empty')).not.toBeNull();
  });

  it('hides a built-in provider and protects the final visible provider', async () => {
    await renderPage();
    const originalTemplateId = useAppStore.getState().configDraft.activeProviderTemplateId;
    await click(deleteActiveProviderButton(container));
    expect(useAppStore.getState().configDraft.activeProviderTemplateId).not.toBe(originalTemplateId);
    expect(window.localStorage.getItem('omni.providerTemplateCatalogPrefs')).toContain(`"templateId":"${originalTemplateId}"`);
    expect(window.localStorage.getItem('omni.providerTemplateCatalogPrefs')).toContain('"hidden":true');

    const currentTemplateId = useAppStore.getState().configDraft.activeProviderTemplateId;
    window.localStorage.setItem(
      'omni.providerTemplateCatalogPrefs',
      JSON.stringify(
        providerTemplates.map((template, order) => ({
          templateId: template.id,
          enabled: true,
          hidden: template.id !== currentTemplateId,
          order,
        })),
      ),
    );
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await renderPage();
    await click(deleteActiveProviderButton(container));
    expect(useAppStore.getState().configDraft.activeProviderTemplateId).toBe(currentTemplateId);
  });

  it('shows model catalog blocked and runtime request failure messages', async () => {
    setTauriRuntime(true);
    const snapshot = structuredClone(runtimeSnapshotMock);
    snapshot.storage.status = 'preview';
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot: snapshot }));
    await renderPage();
    await click(Array.from(container.querySelectorAll<HTMLButtonElement>('.provider-action-row button')).at(-2));
    expect(container.querySelector('.provider-model-modal')).not.toBeNull();

    setTauriRuntime(false);
    await click(Array.from(modelCatalogDialog(container)!.querySelectorAll<HTMLButtonElement>('.provider-model-toolbar .provider-header-icon')).at(-1));
    fetchProviderModelsMock.mockRejectedValueOnce('catalog unavailable');
    await click(Array.from(container.querySelectorAll<HTMLButtonElement>('.provider-action-row button')).at(-2));
    await waitForExpectation(() => expect(container.textContent).toContain('catalog unavailable'));
  });

  it('shows non-preview storage blocked details and skips runtime work', async () => {
    setTauriRuntime(true);
    const state = cloneStoreState();
    state.runtimeSnapshot.bridgeStatus = 'tauri-shell';
    state.runtimeSnapshot.storage.status = 'migrating' as never;
    state.runtimeSnapshot.storage.credentialBackend = 'windows-credential-manager';
    state.runtimeSnapshot.storage.schemaVersion = 17;
    useAppStore.setState((current) => ({ ...current, ...state, runtimeNotifications: state.runtimeSnapshot.notifications }));

    await renderPage();
    await click(Array.from(container.querySelectorAll<HTMLButtonElement>('.provider-action-row button')).at(-2));

    expect(fetchProviderModelsMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('windows-credential-manager');
    expect(container.textContent).toContain('17');
  });

  it('blocks storage-dependent secret, verification and catalog refresh actions', async () => {
    setTauriRuntime(true);
    const state = cloneStoreState();
    state.runtimeSnapshot.bridgeStatus = 'tauri-shell';
    state.runtimeSnapshot.storage.status = 'migrating' as never;
    state.runtimeSnapshot.storage.credentialBackend = 'windows-credential-manager';
    useAppStore.setState((current) => ({ ...current, ...state, runtimeNotifications: state.runtimeSnapshot.notifications }));

    await renderPage();
    await inputText(secretInput(container)!, 'blocked-secret');
    await click(container.querySelector<HTMLButtonElement>('.provider-auth-entry-actions .action-button'));
    await click(revealSecretButton(container));
    await click(buttonContainingText(container, '妤犲矁鐦夐幒銉ュ弳'));
    await click(Array.from(container.querySelectorAll<HTMLButtonElement>('.provider-action-row button')).at(-2));
    const refreshButton = Array.from(modelCatalogDialog(container)!.querySelectorAll<HTMLButtonElement>('.provider-model-toolbar .provider-header-icon')).at(1);
    await click(refreshButton);

    expect(saveProviderSecretMock).not.toHaveBeenCalled();
    expect(readProviderSecretMock).not.toHaveBeenCalled();
    expect(runProviderProbeMock).not.toHaveBeenCalled();
    expect(fetchProviderModelsMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('windows-credential-manager');
  });

  it('uses runtime error fallback messages when no notification is available', async () => {
    const state = cloneStoreState();
    state.runtimeSnapshot.bridgeStatus = 'runtime-error';
    state.runtimeSnapshot.notifications = [];
    useAppStore.setState((current) => ({ ...current, ...state, runtimeNotifications: [] }));

    await renderPage();
    await click(Array.from(container.querySelectorAll<HTMLButtonElement>('.provider-action-row button')).at(-2));

    expect(fetchProviderModelsMock).toHaveBeenCalled();
    expect(container.textContent).toContain('Rust Core');
  });

  it('surfaces secret status, save and plaintext read failures', async () => {
    setTauriRuntime(true);
    const snapshot = structuredClone(runtimeSnapshotMock);
    snapshot.bridgeStatus = 'tauri-shell';
    snapshot.storage.status = 'ready';
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot: snapshot }));
    getProviderSecretStatusMock.mockRejectedValueOnce('status unavailable');
    await renderPage();
    await waitForExpectation(() => expect(container.textContent).toContain('status unavailable'));

    saveProviderSecretMock.mockRejectedValueOnce('save unavailable');
    await inputText(secretInput(container)!, 'new-secret');
    await click(container.querySelector<HTMLButtonElement>('.provider-auth-entry-actions .action-button'));
    expect(container.textContent).toContain('save unavailable');
    expect(useAppStore.getState().configDraft.providers[0].status).toBe('warning');

    await click(revealSecretButton(container));
    expect(secretInput(container)?.type).toBe('text');
    await click(revealSecretButton(container));
    await inputText(secretInput(container)!, '');
    readProviderSecretMock.mockResolvedValueOnce({
      reference: appConfigDraftMock.providers[0].authRef.reference,
      backend: 'windows-credential-manager',
      secret: '',
    });
    await click(revealSecretButton(container));
    expect(container.textContent).toContain('当前认证引用下没有已保存密钥');
    readProviderSecretMock.mockRejectedValueOnce('read unavailable');
    await click(revealSecretButton(container));
    expect(container.textContent).toContain('read unavailable');
  });

  it('saves endpoint-only auth changes without writing an empty secret', async () => {
    setTauriRuntime(true);
    const state = cloneStoreState();
    state.runtimeSnapshot.bridgeStatus = 'tauri-shell';
    state.runtimeSnapshot.storage.status = 'ready';
    useAppStore.setState((current) => ({ ...current, ...state, runtimeNotifications: state.runtimeSnapshot.notifications }));

    await renderPage();
    await inputText(container.querySelector<HTMLInputElement>('.provider-auth-entry-field input')!, 'https://endpoint-only.example/v1');
    await inputText(secretInput(container)!, '');
    await click(container.querySelector<HTMLButtonElement>('.provider-auth-entry-actions .action-button'));

    expect(saveProviderSecretMock).not.toHaveBeenCalled();
    expect(fetchProviderModelsMock).toHaveBeenCalled();
    expect(useAppStore.getState().configDraft.providers[0].baseUrl).toBe('https://endpoint-only.example/v1');
  });

  it('adds and removes a manual scene model from the Enter keyboard path', async () => {
    await renderPage();
    await click(sceneAddButtons(container)[0]);
    const input = container.querySelector<HTMLInputElement>('.provider-scene-manual-row input')!;
    await inputText(input, 'keyboard-model');
    await dispatch(input, new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    await confirmPendingModelRegistration(container);
    expect(useAppStore.getState().configDraft.providers[0].sceneModelAssignments[0]?.modelIds).toContain('keyboard-model');

    await click(deleteSceneModelButton(container, 'keyboard-model'));
    expect(useAppStore.getState().configDraft.providers[0].sceneModelAssignments[0]?.modelIds).not.toContain('keyboard-model');
  });

  it('hydrates a matching cached model catalog without fetching it again', async () => {
    const state = cloneStoreState();
    const provider = state.configDraft.providers[0];
    const signature = providersPageHelpers.buildModelCatalogSignature(provider);
    provider.modelCatalogCache = {
      signature,
      source: 'runtime',
      fetchedAt: '2026-06-01T00:00:00Z',
      endpoint: 'https://cached.example/models',
      models: [{ id: 'cached-model', displayName: 'cached-model', ownedBy: null, createdAt: null, capabilities: ['speech-to-text'], providerTemplateId: 'pt', providerTemplateName: 'Provider' }],
      error: null,
    };
    useAppStore.setState((current) => ({ ...current, ...state }));
    await renderPage();
    expect(container.textContent).toContain('https://cached.example/models');
    expect(fetchProviderModelsMock).not.toHaveBeenCalled();
  });

  it('toggles pending manual model registration capabilities before confirming', async () => {
    await renderPage();
    await click(sceneAddButtons(container)[0]);
    const input = container.querySelector<HTMLInputElement>('.provider-scene-manual-row input')!;

    await inputText(input, 'custom-vision-chat');
    await click(manualModelAddButton(container));

    const dialog = pendingRegistrationDialog(container, 'custom-vision-chat')!;
    const pillGroups = Array.from(dialog.querySelectorAll<HTMLElement>('.provider-capability-registry-pills'));
    const capabilityButtons = Array.from(pillGroups[0].querySelectorAll<HTMLButtonElement>('button'));
    for (const button of capabilityButtons.filter((item) => item.classList.contains('provider-scenario-pill-active'))) {
      await click(button);
    }
    expect(dialog.querySelector<HTMLButtonElement>('.provider-modal-actions .provider-primary-action')?.disabled).toBe(true);

    await click(capabilityButtons.find((button) => !button.classList.contains('provider-scenario-pill-active')));
    expect(dialog.querySelector<HTMLButtonElement>('.provider-modal-actions .provider-primary-action')?.disabled).toBe(false);

    const interactionButtons = Array.from(pillGroups[1].querySelectorAll<HTMLButtonElement>('button'));
    await click(interactionButtons.at(-1));
    await selectValue(dialog.querySelector<HTMLSelectElement>('select')!, 'semantic_vad');
    await confirmPendingModelRegistration(container);

    const registryEntry = useAppStore.getState().configDraft.providers[0].localModelCapabilityRegistry.find((entry) => entry.modelId === 'custom-vision-chat');
    expect(registryEntry?.capabilities.length).toBe(1);
    expect(registryEntry?.realtimeAudioMode).toBe('semantic_vad');
    expect(registryEntry?.interactionCapabilities?.length ?? 0).toBeGreaterThan(0);
  });

  it('registers a manual model for a non-active scene without changing the active model', async () => {
    const state = cloneStoreState();
    state.configDraft.devices.routeMode = 'watch';
    state.configDraft.providers[0].model = 'qwen3.5-omni-plus-realtime';
    state.configDraft.providers[0].sceneModelAssignments = [
      { scenario: 'watch', modelIds: ['qwen3.5-omni-plus-realtime'] },
      { scenario: 'game', modelIds: [] },
      { scenario: 'voice-room', modelIds: [] },
      { scenario: 'subtitle-translate', modelIds: [] },
    ];
    useAppStore.setState((current) => ({ ...current, ...state }));

    await renderPage();
    await click(sceneAddButtons(container)[1]);
    await inputText(container.querySelector<HTMLInputElement>('.provider-scene-manual-row input')!, 'manual-game-model');
    await click(manualModelAddButton(container));

    const dialog = pendingRegistrationDialog(container, 'manual-game-model')!;
    const interactionButtons = Array.from(dialog.querySelectorAll<HTMLElement>('.provider-capability-registry-pills')).at(1)!.querySelectorAll<HTMLButtonElement>('button');
    const activeInteraction = Array.from(interactionButtons).find((button) => button.classList.contains('provider-scenario-pill-active'))!;
    await click(activeInteraction);
    await confirmPendingModelRegistration(container);

    const provider = useAppStore.getState().configDraft.providers[0];
    expect(provider.sceneModelAssignments.find((item) => item.scenario === 'game')?.modelIds).toContain('manual-game-model');
    expect(provider.model).toBe('qwen3.5-omni-plus-realtime');
    expect(provider.localModelCapabilityRegistry.find((entry) => entry.modelId === 'manual-game-model')?.interactionCapabilities).not.toContain(
      activeInteraction.title,
    );
  });

  it('ignores empty manual model submissions and closes pending registration from the backdrop', async () => {
    await renderPage();
    await click(sceneAddButtons(container)[0]);
    const input = container.querySelector<HTMLInputElement>('.provider-scene-manual-row input')!;

    await inputText(input, '   ');
    await click(manualModelAddButton(container));
    expect(pendingRegistrationDialog(container, 'cancel-me')).toBeUndefined();

    await inputText(input, 'cancel-me');
    await click(manualModelAddButton(container));
    const dialog = pendingRegistrationDialog(container, 'cancel-me')!;
    expect(dialog).not.toBeUndefined();
    await click(dialog.parentElement);
    expect(pendingRegistrationDialog(container, 'cancel-me')).toBeUndefined();
    expect(useAppStore.getState().configDraft.providers[0].sceneModelAssignments[0]?.modelIds).not.toContain('cancel-me');
  });

  it('uses an existing registry entry for manual model add without reopening registration', async () => {
    const state = cloneStoreState();
    state.configDraft.providers[0].localModelCapabilityRegistry = [
      {
        id: 'registry-existing-manual',
        modelId: 'existing-manual',
        capabilities: ['speech-to-text'],
        realtimeAudioMode: 'server_vad',
        interactionCapabilities: ['text_only_backend'],
      },
    ];
    useAppStore.setState((current) => ({ ...current, ...state }));

    await renderPage();
    await click(sceneAddButtons(container)[0]);
    await inputText(container.querySelector<HTMLInputElement>('.provider-scene-manual-row input')!, 'existing-manual');
    await click(manualModelAddButton(container));

    expect(pendingRegistrationDialog(container, 'existing-manual')).toBeUndefined();
    expect(useAppStore.getState().configDraft.providers[0].sceneModelAssignments[0]?.modelIds).toContain('existing-manual');
  });

  it('polls desktop storage recovery and falls back to bootstrap on the final attempt', async () => {
    vi.useFakeTimers();
    setTauriRuntime(true);
    const state = cloneStoreState();
    state.runtimeSnapshot.bridgeStatus = 'tauri-shell';
    state.runtimeSnapshot.storage.status = 'preview';
    useAppStore.setState((current) => ({ ...current, ...state, runtimeNotifications: state.runtimeSnapshot.notifications }));
    invokeMock.mockImplementation((command: string) => {
      if (command === 'bootstrap_storage') {
        return Promise.resolve(null);
      }
      if (command === 'get_runtime_snapshot') {
        return Promise.resolve({
          ...state.runtimeSnapshot,
          storage: { ...state.runtimeSnapshot.storage, status: 'preview' },
        });
      }
      if (command === 'bootstrap_runtime') {
        return Promise.resolve({
          ...state.runtimeSnapshot,
          storage: { ...state.runtimeSnapshot.storage, status: 'ready' },
        });
      }
      return Promise.reject(new Error(`unexpected command ${command}`));
    });

    await renderPage();
    await act(async () => {
      await Promise.resolve();
    });

    for (let index = 0; index < 8; index += 1) {
      await act(async () => {
        vi.advanceTimersByTime(2000);
        await Promise.resolve();
      });
    }

    expect(invokeMock).toHaveBeenCalledWith('get_runtime_snapshot');
    expect(invokeMock).toHaveBeenCalledWith('bootstrap_runtime');
    expect(useAppStore.getState().runtimeSnapshot.storage.status).toBe('ready');
  });

  it('reports storage polling failures from non-Error rejections', async () => {
    setTauriRuntime(true);
    const state = cloneStoreState();
    state.runtimeSnapshot.bridgeStatus = 'tauri-shell';
    state.runtimeSnapshot.storage.status = 'preview';
    useAppStore.setState((current) => ({ ...current, ...state, runtimeNotifications: state.runtimeSnapshot.notifications }));
    invokeMock.mockRejectedValue('string failure');

    await renderPage();
    await waitForExpectation(() => expect(container.textContent).toContain('string failure'));
  });

  it('edits capability registry interaction modes and closes audio mode help', async () => {
    await renderPage();
    await click(sceneAddButtons(container)[0]);
    await click(container.querySelector<HTMLButtonElement>('.provider-model-toolbar .provider-header-icon'));

    let dialog = Array.from(container.querySelectorAll<HTMLElement>('.provider-advanced-modal')).find((item) =>
      item.querySelector('.provider-custom-header-list'),
    )!;
    await click(dialog.querySelector<HTMLButtonElement>('.provider-model-toolbar .icon-button'));
    dialog = Array.from(container.querySelectorAll<HTMLElement>('.provider-advanced-modal')).find((item) =>
      item.querySelector('.provider-custom-header-list'),
    )!;
    const entry = dialog.querySelector<HTMLElement>('.provider-capability-registry-item')!;
    await inputText(entry.querySelector<HTMLInputElement>('input')!, 'interaction-model');

    const pillGroups = Array.from(entry.querySelectorAll<HTMLElement>('.provider-capability-registry-pills'));
    await click(pillGroups[0].querySelector<HTMLButtonElement>('button'));
    await click(pillGroups[1].querySelector<HTMLButtonElement>('button[title]'));
    await click(pillGroups[1].querySelector<HTMLButtonElement>('button[title]'));
    await selectValue(entry.querySelector<HTMLSelectElement>('select')!, 'gemini_auto_activity');

    const registryEntry = useAppStore.getState().configDraft.providers[0].localModelCapabilityRegistry.find((item) => item.modelId === 'interaction-model');
    expect(registryEntry?.realtimeAudioMode).toBe('gemini_auto_activity');
    expect(registryEntry?.interactionCapabilities ?? []).not.toContain('auto_vad');

    await click(dialog.querySelectorAll<HTMLButtonElement>('.provider-model-toolbar .provider-header-icon')[0]);
    const helpDialog = Array.from(container.querySelectorAll<HTMLElement>('.provider-advanced-modal')).find((item) =>
      item.querySelector('.audio-mode-help-list'),
    )!;
    expect(helpDialog).toBeTruthy();
    await click(helpDialog.parentElement);
    expect(Array.from(container.querySelectorAll<HTMLElement>('.provider-advanced-modal')).some((item) => item.querySelector('.audio-mode-help-list'))).toBe(false);

    await click(dialog.parentElement);
    expect(Array.from(container.querySelectorAll<HTMLElement>('.provider-advanced-modal')).some((item) => item.querySelector('.provider-custom-header-list'))).toBe(false);
  });

  it('edits advanced response modalities and custom headers', async () => {
    await renderPage();
    await click(Array.from(container.querySelectorAll<HTMLButtonElement>('.provider-action-row button')).at(-1));
    const dialog = Array.from(container.querySelectorAll<HTMLElement>('.provider-advanced-modal')).find((item) =>
      item.querySelector('.provider-custom-header-list') && item.querySelector('textarea'),
    )!;

    const modalityButtons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('.provider-scenario-switcher button'));
    await click(modalityButtons.at(-1));
    expect(useAppStore.getState().configDraft.providers[0].responseModalities).toContain('audio');

    await click(Array.from(dialog.querySelectorAll<HTMLButtonElement>('.provider-setting-header .icon-button')).at(-1));
    const headerRow = dialog.querySelector<HTMLElement>('.provider-custom-header-item')!;
    const inputs = headerRow.querySelectorAll<HTMLInputElement>('input');
    await inputText(inputs[0]!, 'X-Test');
    await inputText(inputs[1]!, 'enabled');
    await selectValue(headerRow.querySelector<HTMLSelectElement>('select')!, 'false');

    expect(useAppStore.getState().configDraft.providers[0].customHeaders[0]).toMatchObject({
      name: 'X-Test',
      value: 'enabled',
      enabled: false,
    });

    await click(headerRow.querySelector<HTMLButtonElement>('.provider-header-icon-danger'));
    expect(useAppStore.getState().configDraft.providers[0].customHeaders).toHaveLength(0);
  });

  it('preserves sibling custom request headers while editing one row', async () => {
    await renderPage();
    await click(Array.from(container.querySelectorAll<HTMLButtonElement>('.provider-action-row button')).at(-1));
    const dialog = advancedSettingsDialog(container)!;
    const addHeaderButton = Array.from(dialog.querySelectorAll<HTMLButtonElement>('.provider-setting-header .icon-button')).at(-1);

    await click(addHeaderButton);
    await click(addHeaderButton);

    const rows = Array.from(dialog.querySelectorAll<HTMLElement>('.provider-custom-header-item'));
    await inputText(rows[0].querySelectorAll<HTMLInputElement>('input')[0], 'X-First');
    await inputText(rows[1].querySelectorAll<HTMLInputElement>('input')[0], 'X-Second');
    await inputText(rows[0].querySelectorAll<HTMLInputElement>('input')[1], 'first-updated');

    expect(useAppStore.getState().configDraft.providers[0].customHeaders).toMatchObject([
      { name: 'X-First', value: 'first-updated' },
      { name: 'X-Second', value: '' },
    ]);
  });

  it('reorders scene models through drag and drop handlers', async () => {
    const state = cloneStoreState();
    state.configDraft.providers[0].sceneModelAssignments[0] = {
      scenario: 'watch',
      modelIds: ['first-drag-model', 'second-drag-model'],
    };
    state.configDraft.providers[0].localModelCapabilityRegistry = [
      { id: 'first-drag', modelId: 'first-drag-model', capabilities: ['speech-to-text'], realtimeAudioMode: 'server_vad', interactionCapabilities: ['auto_vad'] },
      { id: 'second-drag', modelId: 'second-drag-model', capabilities: ['speech-to-text'], realtimeAudioMode: 'server_vad', interactionCapabilities: ['auto_vad'] },
    ];
    useAppStore.setState((current) => ({ ...current, ...state }));

    await renderPage();
    const items = Array.from(container.querySelectorAll<HTMLElement>('.provider-scene-model-item'));
    const first = items.find((item) => item.textContent?.includes('first-drag-model'))!;
    const second = items.find((item) => item.textContent?.includes('second-drag-model'))!;

    await dispatch(first, new Event('dragstart', { bubbles: true }));
    await dispatch(second, new Event('dragover', { bubbles: true }));
    await dispatch(second, new Event('drop', { bubbles: true }));
    await dispatch(first, new Event('dragend', { bubbles: true }));

    expect(useAppStore.getState().configDraft.providers[0].sceneModelAssignments[0]?.modelIds[0]).toBe('second-drag-model');
  });

  it('renders capability registry fallback values and empty state after removals', async () => {
    const state = cloneStoreState();
    state.configDraft.providers[0].localModelCapabilityRegistry = [
      { id: 'fallback-audio', modelId: 'qwen-omni-realtime', capabilities: ['speech-to-speech'] },
      { id: 'fallback-text', modelId: 'plain-text-model', capabilities: ['text-generation'], interactionCapabilities: undefined },
    ] as never;
    useAppStore.setState((current) => ({ ...current, ...state }));

    await renderPage();
    await click(sceneAddButtons(container)[0]);
    await click(container.querySelector<HTMLButtonElement>('.provider-model-toolbar .provider-header-icon'));

    const dialog = capabilityRegistryDialog(container)!;
    const entries = Array.from(dialog.querySelectorAll<HTMLElement>('.provider-capability-registry-item'));
    expect(entries).toHaveLength(2);
    expect(entries[0].querySelector<HTMLSelectElement>('.provider-capability-mode-select')?.value).toBeTruthy();
    expect(entries[1].querySelectorAll<HTMLButtonElement>('.provider-scenario-pill-active').length).toBeGreaterThan(0);

    for (const entry of entries) {
      await click(entry.querySelector<HTMLButtonElement>('.provider-header-icon-danger'));
    }

    expect(useAppStore.getState().configDraft.providers[0].localModelCapabilityRegistry).toHaveLength(0);
    expect(dialog.querySelector('.provider-directory-empty.provider-scene-empty')).not.toBeNull();
  });

  it('adds a catalog model to a non-active scene without replacing the active model', async () => {
    const state = cloneStoreState();
    state.configDraft.devices.routeMode = 'watch';
    state.configDraft.providers[0].model = 'qwen3.5-omni-plus-realtime';
    state.configDraft.providers[0].sceneModelAssignments = [
      { scenario: 'watch', modelIds: ['qwen3.5-omni-plus-realtime'] },
      { scenario: 'game', modelIds: [] },
      { scenario: 'voice-room', modelIds: [] },
      { scenario: 'subtitle-translate', modelIds: [] },
    ];
    useAppStore.setState((current) => ({ ...current, ...state }));

    await renderPage();
    await click(sceneAddButtons(container)[1]);
    let row: HTMLElement | undefined;
    await waitForExpectation(() => {
      row = Array.from(modelCatalogDialog(container)!.querySelectorAll<HTMLElement>('.provider-model-item')).find((item) =>
        item.textContent?.includes('qwen3.5-omni-plus-realtime'),
      );
      expect(row, modelCatalogDialog(container)?.textContent ?? '').toBeTruthy();
    });
    expect(row).toBeTruthy();
    await click(row!.querySelector<HTMLButtonElement>('.provider-row-action'));

    const provider = useAppStore.getState().configDraft.providers[0];
    expect(provider.sceneModelAssignments.find((item) => item.scenario === 'game')?.modelIds).toContain('qwen3.5-omni-plus-realtime');
    expect(provider.model).toBe('qwen3.5-omni-plus-realtime');
  });

  it('renders scene model fallback capability footnote', async () => {
    const state = cloneStoreState();
    state.configDraft.providers[0].sceneModelAssignments[0] = {
      scenario: 'watch',
      modelIds: ['unknown-capability-model'],
    };
    state.configDraft.providers[0].localModelCapabilityRegistry = [];
    state.configDraft.providers[0].modelCatalogCache = {
      ...state.configDraft.providers[0].modelCatalogCache,
      models: [],
    };
    useAppStore.setState((current) => ({ ...current, ...state }));

    await renderPage();

    const modelItem = Array.from(container.querySelectorAll<HTMLElement>('.provider-scene-model-item')).find((item) =>
      item.textContent?.includes('unknown-capability-model'),
    )!;
    expect(modelItem.querySelector('.provider-setting-footnote')).not.toBeNull();
  });

  it('falls back on invalid pending and registry realtime mode selections', async () => {
    await renderPage();
    await click(sceneAddButtons(container)[0]);
    await inputText(container.querySelector<HTMLInputElement>('.provider-scene-manual-row input')!, 'invalid-mode-model');
    await click(manualModelAddButton(container));

    const pending = pendingRegistrationDialog(container, 'invalid-mode-model')!;
    const pendingSelect = pending.querySelector<HTMLSelectElement>('select')!;
    const originalPendingMode = pendingSelect.value;
    await selectValue(pendingSelect, 'not-a-mode');
    await confirmPendingModelRegistration(container);
    expect(useAppStore.getState().configDraft.providers[0].localModelCapabilityRegistry[0]?.realtimeAudioMode).toBe(originalPendingMode);

    await click(sceneAddButtons(container)[0]);
    await click(container.querySelector<HTMLButtonElement>('.provider-model-toolbar .provider-header-icon'));
    const dialog = capabilityRegistryDialog(container)!;
    const entry = dialog.querySelector<HTMLElement>('.provider-capability-registry-item')!;
    await selectValue(entry.querySelector<HTMLSelectElement>('select')!, 'not-a-mode');

    const registryEntry = useAppStore.getState().configDraft.providers[0].localModelCapabilityRegistry.find((item) =>
      item.modelId === 'invalid-mode-model',
    );
    expect(registryEntry?.realtimeAudioMode).toBeTruthy();
    expect(registryEntry?.realtimeAudioMode).not.toBe('not-a-mode');
  });

  it('removes existing registry interaction and capability selections', async () => {
    const state = cloneStoreState();
    state.configDraft.providers[0].localModelCapabilityRegistry = [
      {
        id: 'toggle-existing',
        modelId: 'toggle-existing-model',
        capabilities: ['speech-to-text'],
        realtimeAudioMode: 'server_vad',
        interactionCapabilities: ['auto_vad'],
      },
    ];
    useAppStore.setState((current) => ({ ...current, ...state }));

    await renderPage();
    await click(sceneAddButtons(container)[0]);
    await click(container.querySelector<HTMLButtonElement>('.provider-model-toolbar .provider-header-icon'));

    const dialog = capabilityRegistryDialog(container)!;
    const entry = dialog.querySelector<HTMLElement>('.provider-capability-registry-item')!;
    const pillGroups = Array.from(entry.querySelectorAll<HTMLElement>('.provider-capability-registry-pills'));
    const activeCapability = pillGroups[0].querySelector<HTMLButtonElement>('.provider-scenario-pill-active')!;
    const activeInteraction = pillGroups[1].querySelector<HTMLButtonElement>('.provider-scenario-pill-active')!;

    await click(activeCapability);
    await click(activeInteraction);

    const registryEntry = useAppStore.getState().configDraft.providers[0].localModelCapabilityRegistry[0];
    expect(registryEntry?.capabilities).not.toContain('speech-to-text');
    expect(registryEntry?.interactionCapabilities).not.toContain('auto_vad');
  });
});
