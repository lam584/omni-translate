import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../stores/app-store';
import { resetWelcomeFlag, setUiLanguage } from '../i18n/config';
import { registerDomHarness } from '../test-utils/component-test-harness';
import { resetDriverRuntimeMocks } from '../test-utils/driver-runtime-mock';
import { findButtonByText, seedBridgeSnapshot, seedDriverStoreState } from '../test-utils/driver-store-fixtures';
import SettingsPage from './SettingsPage';

const languageMocks = vi.hoisted(() => ({ current: vi.fn(() => 'zh-CN'), resolved: 'zh-CN' as string | undefined }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: {
      get resolvedLanguage() { return languageMocks.resolved; },
    },
    t: (key: string) =>
      ({
        'driverManagement.action.install': '安装驱动',
        'driverManagement.action.refresh': '重新检测',
        'driverManagement.action.uninstall': '卸载',
        'driverManagement.action.reinstall': '重新安装',
        'settings.languageLoadFailed': '语言资源加载失败，已恢复原语言',
      })[key] ?? key,
  }),
}));

vi.mock('../i18n/config', () => ({
  default: { t: (key: string) => key },
  getCurrentLanguage: languageMocks.current,
  resetWelcomeFlag: vi.fn(),
  setUiLanguage: vi.fn(),
}));

vi.mock('../runtime/bridge-runtime', async () =>
  (await import('../test-utils/driver-runtime-mock')).bridgeRuntimeMockModule());

describe('SettingsPage driver management', () => {
  const view = registerDomHarness({
    realTimersAfterEach: true,
    setup: () => {
      resetDriverRuntimeMocks();
      vi.mocked(resetWelcomeFlag).mockReset();
      vi.mocked(setUiLanguage).mockReset();
      languageMocks.current.mockReturnValue('zh-CN');
      languageMocks.resolved = 'zh-CN';
      seedDriverStoreState();
    },
  });
  let container: HTMLDivElement;

  beforeEach(() => {
    ({ container } = view);
  });

  async function renderSettings() {
    await view.render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
  }

  it('disables install when the driver is installed', async () => {
    seedBridgeSnapshot({ driverHealth: 'running', bridgeState: 'running', driverVersion: '0.9.0-dev' });

    await renderSettings();

    expect(findButtonByText(container, '重新检测')?.disabled).toBe(true);
    expect(findButtonByText(container, '卸载')?.disabled).toBe(false);
    expect(findButtonByText(container, '重新安装')?.disabled).toBe(false);
  });

  it('disables uninstall when the driver is not installed', async () => {
    seedBridgeSnapshot({ driverHealth: 'not-installed', driverVersion: null });

    await renderSettings();

    expect(findButtonByText(container, '安装驱动')?.disabled).toBe(false);
    expect(findButtonByText(container, '卸载')?.disabled).toBe(true);
    expect(findButtonByText(container, '重新安装')?.disabled).toBe(false);
  });

  it('updates UI and translation language preferences including custom fallback', async () => {
    await renderSettings();
    const selects = container.querySelectorAll<HTMLSelectElement>('select');
    await act(async () => {
      selects[0].value = 'en';
      selects[0].dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(setUiLanguage).toHaveBeenCalledWith('en');

    await act(async () => {
      selects[1].value = '__custom__';
      selects[1].dispatchEvent(new Event('change', { bubbles: true }));
    });
    const customInput = container.querySelector<HTMLInputElement>('input[type="text"]');
    expect(customInput).not.toBeNull();
    await act(async () => {
      if (!customInput) return;
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(customInput, 'eo');
      customInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(useAppStore.getState().configDraft.subtitles.translationLanguagePreference).toBe('eo');
    await act(async () => customInput?.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    await act(async () => {
      if (!customInput) return;
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(customInput, '  ');
      customInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      if (!customInput) return;
      customInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(useAppStore.getState().configDraft.subtitles.translationLanguagePreference).toBe('zh-CN');

    await act(async () => {
      selects[1].value = 'en';
      selects[1].dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(useAppStore.getState().configDraft.subtitles.translationLanguagePreference).toBe('en');
  });

  it('restores the previous UI language and reports a lazy-load failure', async () => {
    vi.mocked(setUiLanguage).mockRejectedValueOnce(new Error('chunk unavailable')).mockResolvedValueOnce();
    await renderSettings();
    const select = container.querySelector<HTMLSelectElement>('select')!;

    await act(async () => {
      select.value = 'ja';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setUiLanguage).toHaveBeenNthCalledWith(1, 'ja');
    expect(setUiLanguage).toHaveBeenNthCalledWith(2, 'zh-CN');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('语言资源加载失败');
    expect(select.value).toBe('zh-CN');
  });

  it('falls back to the first language metadata for an unknown persisted language', async () => {
    languageMocks.resolved = undefined;
    languageMocks.current.mockReturnValue('unknown');
    await renderSettings();
    expect(container.textContent).toContain('简体中文');
  });

  it('renders an existing custom translation preference and resets provider and welcome state', async () => {
    vi.useFakeTimers();
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        subtitles: {
          ...state.configDraft.subtitles,
          translationLanguagePreference: 'eo',
        },
      },
    }));
    await renderSettings();
    expect(container.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('eo');

    await act(async () => {
      findButtonByText(container, 'settings.resetProvidersAction')?.click();
      findButtonByText(container, 'settings.resetWelcomeAction')?.click();
    });
    expect(useAppStore.getState().configDraft.providers).toHaveLength(1);
    expect(useAppStore.getState().configDraft.providers[0]?.status).toBe('draft');
    expect(useAppStore.getState().configDraft.diagnostics.providerStatus).toBe('draft');
    expect(resetWelcomeFlag).toHaveBeenCalled();
    expect(container.textContent).toContain('settings.resetProvidersDone');
    expect(container.textContent).toContain('settings.resetWelcomeDone');

    await act(async () => {
      vi.advanceTimersByTime(3200);
    });
    expect(container.textContent).not.toContain('settings.resetProvidersDone');
    expect(container.textContent).not.toContain('settings.resetWelcomeDone');
  });
});
