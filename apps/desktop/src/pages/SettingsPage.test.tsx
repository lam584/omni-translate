import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import { useAppStore } from '../stores/app-store';
import { resetWelcomeFlag, setUiLanguage } from '../i18n/config';
import SettingsPage from './SettingsPage';

const installDriverRuntimeMock = vi.fn();
const repairDriverRuntimeMock = vi.fn();
const uninstallDriverRuntimeMock = vi.fn();
const refreshBridgeRuntimeMock = vi.fn();
const startBridgeServiceRuntimeMock = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: {
      resolvedLanguage: 'zh-CN',
    },
    t: (key: string) =>
      ({
        'driverManagement.action.install': '安装驱动',
        'driverManagement.action.refresh': '重新检测',
        'driverManagement.action.uninstall': '卸载',
        'driverManagement.action.reinstall': '重新安装',
      })[key] ?? key,
  }),
}));

vi.mock('../i18n/config', () => ({
  getCurrentLanguage: () => 'zh-CN',
  resetWelcomeFlag: vi.fn(),
  setUiLanguage: vi.fn(),
}));

vi.mock('../runtime/bridge-runtime', () => ({
  installDriverRuntime: (...args: unknown[]) => installDriverRuntimeMock(...args),
  repairDriverRuntime: (...args: unknown[]) => repairDriverRuntimeMock(...args),
  uninstallDriverRuntime: (...args: unknown[]) => uninstallDriverRuntimeMock(...args),
  refreshBridgeRuntime: (...args: unknown[]) => refreshBridgeRuntimeMock(...args),
  startBridgeServiceRuntime: (...args: unknown[]) => startBridgeServiceRuntimeMock(...args),
}));

function findButtonByText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.textContent?.trim() === text,
  );
}

describe('SettingsPage driver management', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    installDriverRuntimeMock.mockReset();
    repairDriverRuntimeMock.mockReset();
    uninstallDriverRuntimeMock.mockReset();
    refreshBridgeRuntimeMock.mockReset();
    startBridgeServiceRuntimeMock.mockReset();
    vi.mocked(resetWelcomeFlag).mockReset();
    vi.mocked(setUiLanguage).mockReset();

    useAppStore.setState((state) => ({
      ...state,
      configDraft: structuredClone(appConfigDraftMock),
      runtimeNotifications: [],
      runtimeSnapshot: structuredClone(runtimeSnapshotMock),
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
    vi.useRealTimers();
  });

  async function renderSettings() {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>,
      );
    });
  }

  it('disables install when the driver is installed', async () => {
    const snapshot = structuredClone(runtimeSnapshotMock);
    snapshot.bridge.driverHealth = 'running';
    snapshot.bridge.bridgeState = 'running';
    snapshot.bridge.driverVersion = '0.9.0-dev';
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot: snapshot }));

    await act(async () => {
      root.render(
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>,
      );
    });

    expect(findButtonByText(container, '重新检测')?.disabled).toBe(true);
    expect(findButtonByText(container, '卸载')?.disabled).toBe(false);
    expect(findButtonByText(container, '重新安装')?.disabled).toBe(false);
  });

  it('disables uninstall when the driver is not installed', async () => {
    const snapshot = structuredClone(runtimeSnapshotMock);
    snapshot.bridge.driverHealth = 'not-installed';
    snapshot.bridge.driverVersion = null;
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot: snapshot }));

    await act(async () => {
      root.render(
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>,
      );
    });

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
