import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../src/i18n/config';
import i18n from '../../../src/i18n/config';
import { runtimeSnapshotMock } from '../../../src/mocks/runtime-shell';
import { useAppStore } from '../../../src/stores/app-store';
import { cloneStoreState, mountTestRoot, setTauriRuntime, type TestRootHandle } from '../../test-utils';
import WelcomeLanguagePicker from './WelcomeLanguagePicker';

const saveProviderSecretMock = vi.fn();
const runProviderProbeMock = vi.fn();
const readProviderSecretMock = vi.fn();
const refreshBridgeRuntimeMock = vi.fn();

vi.mock('../../runtime/provider-runtime', () => ({
  saveProviderSecret: (...args: unknown[]) => saveProviderSecretMock(...args),
  runProviderProbe: (...args: unknown[]) => runProviderProbeMock(...args),
  readProviderSecret: (...args: unknown[]) => readProviderSecretMock(...args),
}));

vi.mock('../../runtime/bridge-runtime', () => ({
  refreshBridgeRuntime: (...args: unknown[]) => refreshBridgeRuntimeMock(...args),
  installDriverRuntime: vi.fn(),
  repairDriverRuntime: vi.fn(),
  startBridgeServiceRuntime: vi.fn(),
  uninstallDriverRuntime: vi.fn(),
}));

function getFooterButtons(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('.welcome-language-foot-actions button'));
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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

describe('WelcomeLanguagePicker', () => {
  let view: TestRootHandle;
  let container: HTMLDivElement;

  async function renderPicker(onDone: () => void = vi.fn()) {
    await view.render(<WelcomeLanguagePicker initialLanguage="zh-CN" onDone={onDone} />);
  }

  beforeEach(async () => {
    vi.useRealTimers();
    saveProviderSecretMock.mockReset();
    runProviderProbeMock.mockReset();
    readProviderSecretMock.mockReset();
    refreshBridgeRuntimeMock.mockReset();
    refreshBridgeRuntimeMock.mockResolvedValue(structuredClone(runtimeSnapshotMock));
    setTauriRuntime(false);
    window.localStorage.clear();
    await i18n.changeLanguage('zh-CN');

    const { configDraft, runtimeSnapshot } = cloneStoreState();
    useAppStore.setState((state) => ({
      ...state,
      configDraft,
      runtimeSnapshot,
    }));

    view = mountTestRoot();
    ({ container } = view);
  });

  afterEach(async () => {
    await view.cleanup();
    setTauriRuntime(false);
    vi.useRealTimers();
  });

  it('blocks provider save until the desktop runtime and storage are ready', async () => {
    setTauriRuntime(true);
    const { configDraft, runtimeSnapshot } = cloneStoreState();
    runtimeSnapshot.bridgeStatus = 'browser-preview';
    runtimeSnapshot.storage.status = 'preview';

    useAppStore.setState((state) => ({
      ...state,
      configDraft,
      runtimeSnapshot,
    }));

    await renderPicker();

    await click(getFooterButtons(container)[0]!);

    const input = container.querySelector('input[type="password"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    await inputText(input!, 'dashscope-secret');

    const footerButtons = getFooterButtons(container);
    expect(footerButtons[2]?.disabled).toBe(true);
    expect(saveProviderSecretMock).not.toHaveBeenCalled();
  });

  it('saves the default provider key and advances to the driver step', async () => {
    setTauriRuntime(true);
    const { configDraft, runtimeSnapshot } = cloneStoreState();
    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    runtimeSnapshot.storage.status = 'ready';

    useAppStore.setState((state) => ({
      ...state,
      configDraft,
      runtimeSnapshot,
    }));

    saveProviderSecretMock.mockResolvedValue({
      reference: 'credential://provider/dashscope/default',
      backend: 'windows-credential-manager',
      hasSecret: true,
    });

    await renderPicker();

    await click(getFooterButtons(container)[0]!);

    const input = container.querySelector('input[type="password"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    await inputText(input!, 'dashscope-secret');
    await click(getFooterButtons(container)[2]!);

    expect(saveProviderSecretMock).toHaveBeenCalledWith('credential://provider/dashscope/default', 'dashscope-secret');
    expect(runProviderProbeMock).not.toHaveBeenCalled();
    expect(container.querySelector('.driver-management-card')).not.toBeNull();
  });

  it('shows TESTSIGNING guidance on the driver step when the probe reports it disabled', async () => {
    setTauriRuntime(true);
    const { configDraft, runtimeSnapshot } = cloneStoreState();
    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    runtimeSnapshot.storage.status = 'ready';
    runtimeSnapshot.bridge.driverHealth = 'not-installed';
    runtimeSnapshot.bridge.lastErrorCode = 'driver.testsigning-disabled';
    refreshBridgeRuntimeMock.mockResolvedValue(structuredClone(runtimeSnapshot));

    useAppStore.setState((state) => ({
      ...state,
      configDraft,
      runtimeSnapshot,
    }));

    await renderPicker();

    await click(getFooterButtons(container)[0]!);
    await click(getFooterButtons(container)[1]!);

    expect(container.querySelector('.driver-management-card')).not.toBeNull();
    expect(container.textContent).toContain('.\\scripts\\installer\\enable-test-signing.ps1');
  });

  it('shows the runtime bootstrap error instead of allowing provider completion', async () => {
    setTauriRuntime(true);
    const { configDraft, runtimeSnapshot } = cloneStoreState();
    runtimeSnapshot.bridgeStatus = 'runtime-error';
    runtimeSnapshot.coreState = 'degraded';
    runtimeSnapshot.storage.status = 'preview';

    useAppStore.setState((state) => ({
      ...state,
      configDraft,
      runtimeSnapshot,
      runtimeNotifications: [
        {
          id: 'runtime-bootstrap-failed',
          level: 'error',
          source: 'desktop-runtime',
          message: 'Rust Core bridge bootstrap failed',
          emittedAt: new Date().toISOString(),
        },
      ],
    }));

    await renderPicker();

    await click(getFooterButtons(container)[0]!);

    expect(container.textContent).toContain('Rust Core bridge bootstrap failed');
    expect(getFooterButtons(container)[2]?.disabled).toBe(true);
  });

  it('navigates back to language selection from the provider step', async () => {
    await renderPicker();

    const languageButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('.welcome-language-item'));
    await click(languageButtons[1]!);
    await click(getFooterButtons(container)[0]!);
    expect(container.querySelector('select')).not.toBeNull();

    await click(getFooterButtons(container)[0]!);
    expect(container.querySelectorAll('.welcome-language-item')).not.toHaveLength(0);
  });

  it('restores the previous selection and reports a locale activation failure', async () => {
    await i18n.changeLanguage('zh-CN');
    const changeSpy = vi.spyOn(i18n, 'changeLanguage').mockRejectedValueOnce(new Error('locale chunk unavailable'));
    await renderPicker();
    const languageButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('.welcome-language-item'));

    await click(languageButtons.find((button) => button.textContent?.includes('English'))!);

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('locale chunk unavailable');
    expect(container.querySelector<HTMLButtonElement>('.welcome-language-item[aria-selected="true"]')?.textContent).toContain('简体中文');
    changeSpy.mockRestore();
  });

  it('skips provider setup, returns from the driver step and completes the wizard', async () => {
    const onDone = vi.fn();
    await renderPicker(onDone);

    await click(getFooterButtons(container)[0]!);
    await click(getFooterButtons(container)[1]!);
    expect(container.querySelector('.driver-management-card')).not.toBeNull();

    await click(getFooterButtons(container)[0]!);
    expect(container.querySelector('select')).not.toBeNull();
    await click(getFooterButtons(container)[1]!);
    await click(getFooterButtons(container)[2]!);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('continues to driver setup without persisting when the API key is empty', async () => {
    const onDone = vi.fn();
    await renderPicker(onDone);

    await click(getFooterButtons(container)[0]!);
    await click(getFooterButtons(container)[2]!);

    expect(saveProviderSecretMock).not.toHaveBeenCalled();
    expect(container.querySelector('.driver-management-card')).not.toBeNull();
    expect(document.activeElement).toBe(container.querySelector('.welcome-step-title'));
    expect(onDone).not.toHaveBeenCalled();
  });

  it('reveals and hides a stored API key through the credential backend', async () => {
    readProviderSecretMock.mockResolvedValue({
      reference: 'credential://provider/dashscope/default',
      backend: 'windows-credential-manager',
      secret: 'stored-secret',
    });
    await renderPicker();

    await click(getFooterButtons(container)[0]!);
    const toggle = container.querySelector<HTMLButtonElement>('.welcome-secret-toggle')!;
    await click(toggle);
    expect(readProviderSecretMock).toHaveBeenCalledWith('credential://provider/dashscope/default');
    expect(container.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('stored-secret');

    await click(toggle);
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('stored-secret');
  });

  it('shows credential reveal errors from empty and failed backend reads', async () => {
    readProviderSecretMock.mockResolvedValueOnce({
      reference: 'credential://provider/dashscope/default',
      backend: 'windows-credential-manager',
      secret: null,
    });
    await renderPicker();

    await click(getFooterButtons(container)[0]!);
    const toggle = container.querySelector<HTMLButtonElement>('.welcome-secret-toggle')!;
    await click(toggle);
    expect(container.textContent).toContain('API Key');

    readProviderSecretMock.mockRejectedValueOnce(new Error('credential backend unavailable'));
    await click(toggle);
    expect(container.textContent).toContain('读取密钥明文失败');
    expect(container.textContent).not.toContain('credential backend unavailable');
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')).not.toBeNull();

    readProviderSecretMock.mockRejectedValueOnce('credential string failure');
    await click(toggle);
    expect(container.textContent).not.toContain('credential string failure');
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')).not.toBeNull();
  });

  it('falls back to the default template for an unknown selection', async () => {
    await renderPicker();
    await click(getFooterButtons(container)[0]!);
    const templateSelect = container.querySelector<HTMLSelectElement>('select')!;
    await selectValue(templateSelect, 'missing-template');
    expect(container.querySelector<HTMLInputElement>('input[type="url"]')?.value).toBeTruthy();
  });

  it('does not update driver state after a late bridge refresh resolution or rejection', async () => {
    let resolveRefresh!: (value: typeof runtimeSnapshotMock) => void;
    refreshBridgeRuntimeMock.mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    await renderPicker();
    await click(getFooterButtons(container)[0]!);
    await click(getFooterButtons(container)[1]!);
    await click(getFooterButtons(container)[0]!);
    await act(async () => resolveRefresh(structuredClone(runtimeSnapshotMock)));
    expect(container.querySelector('.driver-management-card')).toBeNull();

    let rejectRefresh!: (reason: unknown) => void;
    refreshBridgeRuntimeMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRefresh = reject; }));
    await click(getFooterButtons(container)[1]!);
    await click(getFooterButtons(container)[0]!);
    await act(async () => rejectRefresh(new Error('late failure')));
    expect(container.textContent).not.toContain('late failure');
  });

  it('shows the driver refresh reason and retries from the onboarding step', async () => {
    refreshBridgeRuntimeMock.mockRejectedValueOnce(new Error('Bridge pipe timed out'));
    await renderPicker();
    await click(getFooterButtons(container)[0]!);
    await click(getFooterButtons(container)[1]!);
    await act(async () => { await Promise.resolve(); });

    const alert = container.querySelector<HTMLElement>('.welcome-provider-error');
    expect(alert?.textContent).toContain('Bridge pipe timed out');

    refreshBridgeRuntimeMock.mockResolvedValueOnce(structuredClone(runtimeSnapshotMock));
    await click(alert!.querySelector<HTMLButtonElement>('button')!);
    expect(refreshBridgeRuntimeMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.welcome-provider-error')).toBeNull();
  });

  it('updates the provider template and API address before surfacing save timeouts', async () => {
    setTauriRuntime(true);
    const { configDraft, runtimeSnapshot } = cloneStoreState();
    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    runtimeSnapshot.storage.status = 'ready';
    useAppStore.setState((state) => ({ ...state, configDraft, runtimeSnapshot }));
    saveProviderSecretMock.mockRejectedValue({ code: 'timeout', operation: 'credential-save' });

    await renderPicker();
    await click(getFooterButtons(container)[0]!);
    const templateSelect = container.querySelector<HTMLSelectElement>('select')!;
    const alternateTemplate = Array.from(templateSelect.options).find((option) => option.value !== templateSelect.value)!;
    await selectValue(templateSelect, alternateTemplate.value);
    const baseUrlInput = container.querySelector<HTMLInputElement>('input[type="url"]')!;
    await inputText(baseUrlInput, 'https://custom.example/v1');
    await inputText(container.querySelector<HTMLInputElement>('input[type="password"]')!, 'provider-secret');
    await click(getFooterButtons(container)[2]!);

    expect(saveProviderSecretMock).toHaveBeenCalledWith(expect.any(String), 'provider-secret');
    expect(baseUrlInput.value).toBe('https://custom.example/v1');
    expect(container.querySelector('.welcome-provider-form')).not.toBeNull();
  });

  it('reports asynchronous provider probe timeouts after saving a non-websocket provider', async () => {
    setTauriRuntime(true);
    const { configDraft, runtimeSnapshot } = cloneStoreState();
    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    runtimeSnapshot.storage.status = 'ready';
    useAppStore.setState((state) => ({ ...state, configDraft, runtimeSnapshot }));
    saveProviderSecretMock.mockResolvedValue({
      reference: 'credential://provider/openai-compatible/default',
      backend: 'windows-credential-manager',
      hasSecret: true,
    });
    runProviderProbeMock.mockRejectedValue({ code: 'timeout', operation: 'provider-probe' });

    await renderPicker();
    await click(getFooterButtons(container)[0]!);
    const templateSelect = container.querySelector<HTMLSelectElement>('select')!;
    const nonWebsocketTemplate = Array.from(templateSelect.options).find((option) => option.value.includes('openai-compatible'))!;
    await selectValue(templateSelect, nonWebsocketTemplate.value);
    await inputText(container.querySelector<HTMLInputElement>('input[type="password"]')!, 'provider-secret');
    await click(getFooterButtons(container)[2]!);
    await act(async () => {
      await Promise.resolve();
    });

    expect(runProviderProbeMock).toHaveBeenCalledTimes(1);
  });

  it('uses the translated runtime fallback when no bootstrap error notification exists', async () => {
    setTauriRuntime(true);
    const { configDraft, runtimeSnapshot } = cloneStoreState();
    runtimeSnapshot.bridgeStatus = 'runtime-error';
    runtimeSnapshot.coreState = 'degraded';
    runtimeSnapshot.storage.status = 'preview';
    useAppStore.setState((state) => ({ ...state, configDraft, runtimeSnapshot, runtimeNotifications: [] }));

    await renderPicker();
    await click(getFooterButtons(container)[0]!);

    expect(container.textContent).toContain('桌面运行时');
    expect(getFooterButtons(container)[2]?.disabled).toBe(true);
  });

  it('reveals an entered API key locally without reading the credential backend', async () => {
    await renderPicker();
    await click(getFooterButtons(container)[0]!);
    await inputText(container.querySelector<HTMLInputElement>('input[type="password"]')!, 'entered-secret');

    const toggle = container.querySelector<HTMLButtonElement>('.welcome-secret-toggle')!;
    await click(toggle);
    expect(readProviderSecretMock).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('entered-secret');
    await click(toggle);
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('entered-secret');
  });

  it('uses default endpoint and first provider when saving after active provider identity is stale', async () => {
    setTauriRuntime(true);
    const { configDraft, runtimeSnapshot } = cloneStoreState();
    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    runtimeSnapshot.storage.status = 'ready';
    configDraft.activeProviderTemplateId = 'missing-template';
    useAppStore.setState((state) => ({ ...state, configDraft, runtimeSnapshot }));
    saveProviderSecretMock.mockResolvedValue({ hasSecret: true });
    runProviderProbeMock.mockResolvedValue({ verdict: 'unavailable', error: { message: '  denied  ' } });

    await renderPicker();
    await click(getFooterButtons(container)[0]!);
    const templateSelect = container.querySelector<HTMLSelectElement>('select')!;
    const nonWebsocketTemplate = Array.from(templateSelect.options).find((option) => option.value.includes('openai-compatible'))!;
    await selectValue(templateSelect, nonWebsocketTemplate.value);
    await inputText(container.querySelector<HTMLInputElement>('input[type="url"]')!, '   ');
    await inputText(container.querySelector<HTMLInputElement>('input[type="password"]')!, 'provider-secret');
    await click(getFooterButtons(container)[2]!);
    await act(async () => {
      await Promise.resolve();
    });

    expect(runProviderProbeMock).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: expect.stringMatching(/^https?:/) }));
    expect(container.textContent).toContain('API Key 无效或已失效');
  });

  it('returns safely when provider configuration is empty and formats unavailable probes without detail', async () => {
    setTauriRuntime(true);
    const { configDraft, runtimeSnapshot } = cloneStoreState();
    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    runtimeSnapshot.storage.status = 'ready';
    configDraft.providers = [];
    useAppStore.setState((state) => ({ ...state, configDraft, runtimeSnapshot }));
    await renderPicker();
    await click(getFooterButtons(container)[0]!);
    await inputText(container.querySelector<HTMLInputElement>('input[type="password"]')!, 'secret');
    await click(getFooterButtons(container)[2]!);
    expect(saveProviderSecretMock).not.toHaveBeenCalled();

    const next = cloneStoreState();
    next.runtimeSnapshot.bridgeStatus = 'tauri-shell';
    next.runtimeSnapshot.storage.status = 'ready';
    useAppStore.setState((state) => ({ ...state, configDraft: next.configDraft, runtimeSnapshot: next.runtimeSnapshot }));
    await renderPicker();
    saveProviderSecretMock.mockResolvedValue({ hasSecret: true });
    runProviderProbeMock.mockResolvedValue({ verdict: 'unavailable', error: { message: '   ' } });
    const select = container.querySelector<HTMLSelectElement>('select')!;
    const nonWebsocket = Array.from(select.options).find((option) => option.value.includes('openai-compatible'))!;
    await selectValue(select, nonWebsocket.value);
    await inputText(container.querySelector<HTMLInputElement>('input[type="password"]')!, 'secret');
    await click(getFooterButtons(container)[2]!);
    await act(async () => Promise.resolve());
    expect(container.textContent).toContain('API Key');
  });

  it('shows non-error refresh failures after entering the driver step', async () => {
    refreshBridgeRuntimeMock.mockRejectedValue('bridge refresh unavailable');
    await renderPicker();
    await click(getFooterButtons(container)[0]!);
    await click(getFooterButtons(container)[1]!);
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('bridge refresh unavailable');
  });

  it('shows Error refresh failures and accepts an available provider probe', async () => {
    refreshBridgeRuntimeMock.mockRejectedValueOnce(new Error('bridge Error failure'));
    await renderPicker();
    await click(getFooterButtons(container)[0]!);
    await click(getFooterButtons(container)[1]!);
    await act(async () => Promise.resolve());
    expect(container.textContent).toContain('bridge Error failure');

    await click(getFooterButtons(container)[0]!);
    saveProviderSecretMock.mockResolvedValue({ hasSecret: true });
    runProviderProbeMock.mockResolvedValue({ verdict: 'available', error: null });
    const select = container.querySelector<HTMLSelectElement>('select')!;
    const nonWebsocket = Array.from(select.options).find((option) => option.value.includes('openai-compatible'))!;
    await selectValue(select, nonWebsocket.value);
    await inputText(container.querySelector<HTMLInputElement>('input[type="password"]')!, 'key');
    await click(getFooterButtons(container)[2]!);
    await act(async () => Promise.resolve());
    expect(runProviderProbeMock).toHaveBeenCalled();
  });
});
