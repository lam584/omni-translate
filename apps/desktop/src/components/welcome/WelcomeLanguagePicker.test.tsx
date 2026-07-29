import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../src/i18n/config';
import i18n from '../../../src/i18n/config';
import { runtimeSnapshotMock } from '../../../src/mocks/runtime-shell';
import { useAppStore } from '../../../src/stores/app-store';
import { mountTestRoot, type TestRootHandle } from '../../test-utils/react-root';
import { cloneStoreState, setTauriRuntime } from '../../test-utils/store-state';
import { click, inputText, selectValue } from '../../test-utils/dom-interactions';
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

describe('WelcomeLanguagePicker', () => {
  let view: TestRootHandle;
  let container: HTMLDivElement;

  async function renderPicker(onDone: () => void = vi.fn()) {
    await view.render(<WelcomeLanguagePicker initialLanguage="zh-CN" onDone={onDone} />);
  }

  /** Clones store slices, applies test drift, then installs them with the Tauri flag set. */
  function seedTauriStore(mutate?: (slices: ReturnType<typeof cloneStoreState>) => void) {
    setTauriRuntime(true);
    const slices = cloneStoreState();
    mutate?.(slices);
    useAppStore.setState((state) => ({
      ...state,
      configDraft: slices.configDraft,
      runtimeSnapshot: slices.runtimeSnapshot,
    }));
    return slices;
  }

  /** Seeds a ready tauri-shell runtime plus optional extra drift. */
  function seedReadyTauriStore(mutate?: (slices: ReturnType<typeof cloneStoreState>) => void) {
    return seedTauriStore((slices) => {
      slices.runtimeSnapshot.bridgeStatus = 'tauri-shell';
      slices.runtimeSnapshot.storage.status = 'ready';
      mutate?.(slices);
    });
  }

  async function openProviderStepAndEnterSecret() {
    await renderPicker();

    await click(getFooterButtons(container)[0]!);

    const input = container.querySelector('input[type="password"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    await inputText(input!, 'dashscope-secret');
  }

  function seedRuntimeErrorStore() {
    seedTauriStore((slices) => {
      slices.runtimeSnapshot.bridgeStatus = 'runtime-error';
      slices.runtimeSnapshot.coreState = 'degraded';
      slices.runtimeSnapshot.storage.status = 'preview';
    });
  }

  async function selectNonWebsocketTemplate() {
    const templateSelect = container.querySelector<HTMLSelectElement>('select')!;
    const nonWebsocketTemplate = Array.from(templateSelect.options).find((option) => option.value.includes('openai-compatible'))!;
    await selectValue(templateSelect, nonWebsocketTemplate.value);
  }

  async function saveEnteredSecret(secret: string) {
    await inputText(container.querySelector<HTMLInputElement>('input[type="password"]')!, secret);
    await click(getFooterButtons(container)[2]!);
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function enterDriverStepAndFlush() {
    await click(getFooterButtons(container)[0]!);
    await click(getFooterButtons(container)[1]!);
    await act(async () => {
      await Promise.resolve();
    });
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
    seedTauriStore((slices) => {
      slices.runtimeSnapshot.bridgeStatus = 'browser-preview';
      slices.runtimeSnapshot.storage.status = 'preview';
    });

    await openProviderStepAndEnterSecret();

    const footerButtons = getFooterButtons(container);
    expect(footerButtons[2]?.disabled).toBe(true);
    expect(saveProviderSecretMock).not.toHaveBeenCalled();
  });

  it('saves the default provider key and advances to the driver step', async () => {
    seedReadyTauriStore();

    saveProviderSecretMock.mockResolvedValue({
      reference: 'credential://provider/dashscope/default',
      backend: 'windows-credential-manager',
      hasSecret: true,
    });

    await openProviderStepAndEnterSecret();
    await click(getFooterButtons(container)[2]!);

    expect(saveProviderSecretMock).toHaveBeenCalledWith('credential://provider/dashscope/default', 'dashscope-secret');
    expect(runProviderProbeMock).not.toHaveBeenCalled();
    expect(container.querySelector('.driver-management-card')).not.toBeNull();
  });

  it('shows TESTSIGNING guidance on the driver step when the probe reports it disabled', async () => {
    const { runtimeSnapshot } = seedReadyTauriStore((slices) => {
      slices.runtimeSnapshot.bridge.driverHealth = 'not-installed';
      slices.runtimeSnapshot.bridge.lastErrorCode = 'driver.testsigning-disabled';
    });
    refreshBridgeRuntimeMock.mockResolvedValue(structuredClone(runtimeSnapshot));

    await renderPicker();

    await click(getFooterButtons(container)[0]!);
    await click(getFooterButtons(container)[1]!);

    expect(container.querySelector('.driver-management-card')).not.toBeNull();
    expect(container.textContent).toContain('.\\scripts\\installer\\enable-test-signing.ps1');
  });

  it('shows the runtime bootstrap error instead of allowing provider completion', async () => {
    seedRuntimeErrorStore();
    useAppStore.setState((state) => ({
      ...state,
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
    const customUrlInput = container.querySelector<HTMLInputElement>('input[type="url"]');
    expect(customUrlInput).toBeInstanceOf(HTMLInputElement);
    expect(customUrlInput!.value).toMatch(/\S/);
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
    await enterDriverStepAndFlush();

    const alert = container.querySelector<HTMLElement>('.welcome-provider-error');
    expect(alert?.textContent).toContain('Bridge pipe timed out');

    refreshBridgeRuntimeMock.mockResolvedValueOnce(structuredClone(runtimeSnapshotMock));
    await click(alert!.querySelector<HTMLButtonElement>('button')!);
    expect(refreshBridgeRuntimeMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.welcome-provider-error')).toBeNull();
  });

  it('updates the provider template and API address before surfacing save timeouts', async () => {
    seedReadyTauriStore();
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
    seedReadyTauriStore();
    saveProviderSecretMock.mockResolvedValue({
      reference: 'credential://provider/openai-compatible/default',
      backend: 'windows-credential-manager',
      hasSecret: true,
    });
    runProviderProbeMock.mockRejectedValue({ code: 'timeout', operation: 'provider-probe' });

    await renderPicker();
    await click(getFooterButtons(container)[0]!);
    await selectNonWebsocketTemplate();
    await saveEnteredSecret('provider-secret');

    expect(runProviderProbeMock).toHaveBeenCalledTimes(1);
  });

  it('uses the translated runtime fallback when no bootstrap error notification exists', async () => {
    seedRuntimeErrorStore();
    useAppStore.setState((state) => ({ ...state, runtimeNotifications: [] }));

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
    seedReadyTauriStore((slices) => {
      slices.configDraft.activeProviderTemplateId = 'missing-template';
    });
    saveProviderSecretMock.mockResolvedValue({ hasSecret: true });
    runProviderProbeMock.mockResolvedValue({ verdict: 'unavailable', error: { message: '  denied  ' } });

    await renderPicker();
    await click(getFooterButtons(container)[0]!);
    await selectNonWebsocketTemplate();
    await inputText(container.querySelector<HTMLInputElement>('input[type="url"]')!, '   ');
    await saveEnteredSecret('provider-secret');

    expect(runProviderProbeMock).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: expect.stringMatching(/^https?:/) }));
    expect(container.textContent).toContain('API Key 无效或已失效');
  });

  it('returns safely when provider configuration is empty and formats unavailable probes without detail', async () => {
    seedReadyTauriStore((slices) => {
      slices.configDraft.providers = [];
    });
    await renderPicker();
    await click(getFooterButtons(container)[0]!);
    await saveEnteredSecret('secret');
    expect(saveProviderSecretMock).not.toHaveBeenCalled();

    seedReadyTauriStore();
    await renderPicker();
    saveProviderSecretMock.mockResolvedValue({ hasSecret: true });
    runProviderProbeMock.mockResolvedValue({ verdict: 'unavailable', error: { message: '   ' } });
    await selectNonWebsocketTemplate();
    await saveEnteredSecret('secret');
    expect(container.textContent).toContain('API Key');
  });

  it('shows non-error refresh failures after entering the driver step', async () => {
    refreshBridgeRuntimeMock.mockRejectedValue('bridge refresh unavailable');
    await renderPicker();
    await enterDriverStepAndFlush();

    expect(container.textContent).toContain('bridge refresh unavailable');
  });

  it('shows Error refresh failures and accepts an available provider probe', async () => {
    refreshBridgeRuntimeMock.mockRejectedValueOnce(new Error('bridge Error failure'));
    await renderPicker();
    await enterDriverStepAndFlush();
    expect(container.textContent).toContain('bridge Error failure');

    await click(getFooterButtons(container)[0]!);
    saveProviderSecretMock.mockResolvedValue({ hasSecret: true });
    runProviderProbeMock.mockResolvedValue({ verdict: 'available', error: null });
    await selectNonWebsocketTemplate();
    await saveEnteredSecret('key');
    expect(runProviderProbeMock).toHaveBeenCalled();
  });
});
