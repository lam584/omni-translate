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
  return buttons(container).find((button) => button.textContent?.trim() === text);
}

function buttonContainingText(container: HTMLElement, text: string) {
  return buttons(container).find((button) => button.textContent?.includes(text));
}

function secretInput(container: HTMLElement) {
  return container.querySelector<HTMLInputElement>('input[placeholder="密钥"]');
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

  it('creates a custom provider and switches to it', async () => {
    await renderPage();

    await click(addPlatformButton(container));
    await inputText(modalInput(container, 0), 'OpenRouter Custom');
    await inputText(modalInput(container, 1), 'https://openrouter.ai/api/v1');
    await click(buttonByText(container, '创建平台'));

    const created = useAppStore.getState().configDraft.providers.find(
      (p) => p.templateId === useAppStore.getState().configDraft.activeProviderTemplateId,
    );
    expect(created?.displayName).toBe('OpenRouter Custom');
    expect(created?.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('adds a manual model id to the selected scene', async () => {
    await renderPage();

    await click(sceneAddButtons(container)[0]);
    await inputText(container.querySelector<HTMLInputElement>('.provider-scene-manual-row input')!, 'manual-scene-model');
    await click(buttonByText(container, '手动添加'));

    expect(useAppStore.getState().configDraft.providers[0].sceneModelAssignments[0]?.modelIds).toContain('manual-scene-model');
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
    expect(container.querySelector('[aria-label="模型列表"]')).not.toBeNull();
    await waitForExpectation(() => expect(container.textContent).toContain('qwen-extra-live'));

    const modelRow = Array.from(container.querySelectorAll<HTMLElement>('.provider-model-item')).find((item) => item.textContent?.includes('qwen-extra-live'));
    await click(Array.from(modelRow!.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes('添加')));

    expect(useAppStore.getState().configDraft.providers[0].sceneModelAssignments[0]?.modelIds).toContain('qwen-extra-live');
  });

  it('updates provider advanced settings', async () => {
    await renderPage();

    await click(buttonContainingText(container, '高级设置'));
    const dialog = container.querySelector<HTMLElement>('[aria-label="高级设置"]');
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

    await click(buttonContainingText(container, '验证接入'));

    expect(runProviderProbeMock).toHaveBeenCalled();
    expect(runProviderSmokeMock).toHaveBeenCalled();
    expect(container.querySelector('[aria-label="验证详情"]')).not.toBeNull();
  });

  it('deletes the active custom provider and returns to a built-in template', async () => {
    await renderPage();
    await click(addPlatformButton(container));
    await inputText(modalInput(container, 0), 'Temporary Custom');
    await inputText(modalInput(container, 1), 'https://custom.example/v1');
    await click(buttonByText(container, '创建平台'));

    const customTemplateId = useAppStore.getState().configDraft.activeProviderTemplateId;
    expect(customTemplateId).toContain('template-custom-temporary-custom-');
    await click(container.querySelector<HTMLButtonElement>('[title="删除当前平台"]'));

    expect(useAppStore.getState().configDraft.activeProviderTemplateId).not.toBe(customTemplateId);
    expect(useAppStore.getState().configDraft.providers.some((provider) => provider.templateId === customTemplateId)).toBe(
      false,
    );
  });

  it('removes a manually added scene model', async () => {
    await renderPage();
    await click(sceneAddButtons(container)[0]);
    await inputText(container.querySelector<HTMLInputElement>('.provider-scene-manual-row input')!, 'remove-me');
    await click(buttonByText(container, '手动添加'));
    expect(useAppStore.getState().configDraft.providers[0].sceneModelAssignments[0]?.modelIds).toContain('remove-me');

    const deleteButton = Array.from(container.querySelectorAll<HTMLButtonElement>('[title="删除已添加模型"]')).find((button) =>
      button.parentElement?.parentElement?.textContent?.includes('remove-me'),
    );
    await click(deleteButton);
    expect(useAppStore.getState().configDraft.providers[0].sceneModelAssignments[0]?.modelIds).not.toContain('remove-me');
  });

  it('adds, edits, disables and deletes a custom request header', async () => {
    await renderPage();
    await click(buttonContainingText(container, '高级设置'));
    const dialog = container.querySelector<HTMLElement>('[aria-label="高级设置"]')!;
    await click(buttonContainingText(dialog, '添加请求头'));

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

    await click(header.querySelector<HTMLButtonElement>('[title="删除请求头"]'));
    expect(useAppStore.getState().configDraft.providers[0].customHeaders).toEqual([]);
  });

  it('adds, toggles and removes a local model capability registry entry', async () => {
    await renderPage();
    await click(sceneAddButtons(container)[0]);
    await click(container.querySelector<HTMLButtonElement>('[title="编辑能力注册表"]'));
    const dialog = container.querySelector<HTMLElement>('[aria-label="能力注册表"]')!;
    await click(buttonContainingText(dialog, '添加条目'));

    const entry = dialog.querySelector<HTMLElement>('.provider-capability-registry-item')!;
    await inputText(entry.querySelector<HTMLInputElement>('input')!, 'custom-asr-model');
    await click(entry.querySelector<HTMLButtonElement>('.provider-capability-chip') ?? entry.querySelector('button'));
    expect(useAppStore.getState().configDraft.providers[0].localModelCapabilityRegistry.some((item) => item.modelId === 'custom-asr-model')).toBe(
      true,
    );

    await click(entry.querySelector<HTMLButtonElement>('[title="删除能力条目"]'));
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
    const endpointInput = fieldControl<HTMLInputElement>(container, 'API 地址', 'input')!;
    await inputText(endpointInput, 'https://temporary.example/v1');
    expect(useAppStore.getState().configDraft.providers[0].baseUrl).toBe('https://temporary.example/v1');

    await click(container.querySelector<HTMLButtonElement>('[title="重置 API 地址"]'));
    expect(useAppStore.getState().configDraft.providers[0].baseUrl).toBe(appConfigDraftMock.providers[0].baseUrl);

    await click(container.querySelector<HTMLButtonElement>('[aria-label="显示密钥"]'));
    expect(readProviderSecretMock).toHaveBeenCalled();
    expect(secretInput(container)?.type).toBe('text');
    await click(container.querySelector<HTMLButtonElement>('[aria-label="隐藏密钥"]'));
    expect(secretInput(container)?.type).toBe('password');
  });

  it('filters, toggles and mouse-drags provider directory entries', async () => {
    await renderPage();
    const query = container.querySelector<HTMLInputElement>('.provider-directory-search-input')!;
    const initialCount = directoryItems(container).length;
    await inputText(query, 'deepseek');
    expect(directoryItems(container).length).toBeLessThan(initialCount);
    await inputText(query, '');

    const first = directoryItems(container)[0];
    const second = directoryItems(container)[1];
    await click(first.querySelector<HTMLElement>('.provider-directory-item-state'));
    expect(window.localStorage.getItem('omni.providerTemplateCatalogPrefs')).toContain('"enabled":false');

    await dispatch(first, new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    await dispatch(second, new MouseEvent('mouseover', { bubbles: true, buttons: 1, clientX: 30, clientY: 30 }));
    await dispatch(window, new MouseEvent('mouseup', { bubbles: true }));
    expect(window.localStorage.getItem('omni.providerTemplateCatalogPrefs')).toContain('"order":');
  });

  it('updates advanced provider fields, response modalities and closes the dialog', async () => {
    await renderPage();
    await click(buttonContainingText(container, '高级设置'));
    const dialog = container.querySelector<HTMLElement>('[aria-label="高级设置"]')!;
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

    await click(dialog.querySelector<HTMLButtonElement>('[title="关闭高级设置"]'));
    expect(container.querySelector('[aria-label="高级设置"]')).toBeNull();
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
    await click(buttonByText(dialog, '取消'));
    expect(container.querySelector('.provider-modal')).toBeNull();
  });

  it('filters, refreshes and closes the model catalog', async () => {
    await renderPage();
    await click(sceneAddButtons(container)[0]);
    const dialog = container.querySelector<HTMLElement>('[aria-label="模型列表"]')!;

    await click(dialog.querySelector<HTMLButtonElement>('[title="刷新模型目录"]'));
    await inputText(dialog.querySelector<HTMLInputElement>('input[placeholder="搜索模型..."]')!, 'qwen-plus');
    await click(Array.from(dialog.querySelectorAll<HTMLButtonElement>('.provider-scenario-pill')).at(-1));
    await dispatch(dialog, new MouseEvent('click', { bubbles: true }));
    expect(container.querySelector('[aria-label="模型列表"]')).not.toBeNull();

    await click(dialog.querySelector<HTMLButtonElement>('[title="关闭模型列表"]'));
    expect(container.querySelector('[aria-label="模型列表"]')).toBeNull();
  });

  it('closes capability registry and verification dialogs through their close controls', async () => {
    await renderPage();
    await click(sceneAddButtons(container)[0]);
    await click(container.querySelector<HTMLButtonElement>('[title="编辑能力注册表"]'));
    await click(container.querySelector<HTMLButtonElement>('[title="关闭能力注册表"]'));
    expect(container.querySelector('[aria-label="能力注册表"]')).toBeNull();

    await click(container.querySelector<HTMLButtonElement>('[title="关闭模型列表"]'));
    await click(buttonContainingText(container, '验证接入'));
    await click(container.querySelector<HTMLButtonElement>('[title="关闭验证详情"]'));
    expect(container.querySelector('[aria-label="验证详情"]')).toBeNull();
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

    await click(buttonContainingText(container, '验证接入'));

    expect(container.textContent).toContain('probe denied');
    expect(container.textContent).toContain('check endpoint');
    expect(container.textContent).toContain('retry later');

    await click(container.querySelector<HTMLButtonElement>('[title="关闭验证详情"]'));
    runProviderProbeMock.mockResolvedValue({
      ...await runProviderProbeMock(),
      verdict: 'available',
      error: null,
      guidance: [],
    });
    await click(buttonContainingText(container, '验证接入'));

    expect(container.textContent).toContain('smoke denied');
    expect(container.textContent).toContain('request rejected');
    expect(container.textContent).toContain('已触发');
  });

  it('marks provider verification warning when probe throws', async () => {
    runProviderProbeMock.mockRejectedValue('probe unavailable');
    await renderPage();

    await click(buttonContainingText(container, '验证接入'));

    expect(useAppStore.getState().configDraft.providers[0].status).toBe('warning');
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

    await waitForExpectation(() => expect(container.textContent).toContain('上游未返回模型目录'));
    await click(container.querySelector<HTMLElement>('.provider-modal-backdrop'));
    expect(container.querySelector('[aria-label="模型列表"]')).toBeNull();
  });

  it('validates missing custom provider name and base URL', async () => {
    await renderPage();
    await click(addPlatformButton(container));
    await click(buttonByText(container, '创建平台'));
    expect(container.textContent).toContain('平台名称');

    await inputText(modalInput(container, 0), 'Incomplete Provider');
    await inputText(modalInput(container, 1), '');
    await click(buttonByText(container, '创建平台'));
    expect(container.textContent).toContain('接口地址');
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
    await click(buttonContainingText(container, '高级设置'));
    const dialog = container.querySelector<HTMLElement>('[aria-label="高级设置"]')!;
    await inputText(fieldControl<HTMLInputElement>(dialog, '超时阈值', 'input')!, '');
    await inputText(fieldControl<HTMLInputElement>(dialog, 'Temperature', 'input')!, '');
    await inputText(fieldControl<HTMLInputElement>(dialog, 'Max Output Tokens', 'input')!, '');
    await selectValue(fieldControl<HTMLSelectElement>(dialog, 'API 格式', 'select')!, 'dashscope');
    await inputText(fieldControl<HTMLInputElement>(dialog, '区域', 'input')!, 'cn-shanghai');

    expect(useAppStore.getState().configDraft.providers[0]).toMatchObject({
      timeoutMs: 0,
      temperature: 0,
      maxOutputTokens: 1,
      region: 'cn-shanghai',
    });
    await click(container.querySelector<HTMLElement>('.provider-modal-backdrop'));
    expect(container.querySelector('[aria-label="高级设置"]')).toBeNull();
  });

  it('filters the catalog by scene capability', async () => {
    await renderPage();
    await click(sceneAddButtons(container)[0]);
    const dialog = container.querySelector<HTMLElement>('[aria-label="模型列表"]')!;
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
    expect(container.textContent).toContain('没有匹配的平台');
  });

  it('hides a built-in provider and protects the final visible provider', async () => {
    await renderPage();
    const originalTemplateId = useAppStore.getState().configDraft.activeProviderTemplateId;
    await click(container.querySelector<HTMLButtonElement>('[title="删除当前平台"]'));
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
    await click(container.querySelector<HTMLButtonElement>('[title="删除当前平台"]'));
    expect(container.textContent).toContain('至少需要保留一个可用平台');
  });

  it('shows model catalog blocked and runtime request failure messages', async () => {
    setTauriRuntime(true);
    const snapshot = structuredClone(runtimeSnapshotMock);
    snapshot.storage.status = 'preview';
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot: snapshot }));
    await renderPage();
    await click(buttonContainingText(container, '模型列表'));
    expect(container.textContent).toContain('存储层尚未就绪');

    setTauriRuntime(false);
    await click(container.querySelector<HTMLButtonElement>('[title="关闭模型列表"]'));
    fetchProviderModelsMock.mockRejectedValueOnce('catalog unavailable');
    await click(buttonContainingText(container, '模型列表'));
    await waitForExpectation(() => expect(container.textContent).toContain('catalog unavailable'));
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

    await click(container.querySelector<HTMLButtonElement>('[aria-label="显示密钥"]'));
    expect(secretInput(container)?.type).toBe('text');
    await click(container.querySelector<HTMLButtonElement>('[aria-label="隐藏密钥"]'));
    await inputText(secretInput(container)!, '');
    readProviderSecretMock.mockResolvedValueOnce({
      reference: appConfigDraftMock.providers[0].authRef.reference,
      backend: 'windows-credential-manager',
      secret: '',
    });
    await click(container.querySelector<HTMLButtonElement>('[aria-label="显示密钥"]'));
    expect(container.textContent).toContain('当前认证引用下没有已保存密钥');
    readProviderSecretMock.mockRejectedValueOnce('read unavailable');
    await click(container.querySelector<HTMLButtonElement>('[aria-label="显示密钥"]'));
    expect(container.textContent).toContain('read unavailable');
  });

  it('adds and removes a manual scene model from the Enter keyboard path', async () => {
    await renderPage();
    await click(sceneAddButtons(container)[0]);
    const input = container.querySelector<HTMLInputElement>('.provider-scene-manual-row input')!;
    await inputText(input, 'keyboard-model');
    await dispatch(input, new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    expect(useAppStore.getState().configDraft.providers[0].sceneModelAssignments[0]?.modelIds).toContain('keyboard-model');

    const deleteButton = Array.from(container.querySelectorAll<HTMLButtonElement>('[title="删除已添加模型"]')).find((button) =>
      button.parentElement?.parentElement?.textContent?.includes('keyboard-model'),
    );
    await click(deleteButton);
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
});
