import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { useAppStore } from '../stores/app-store';
import SubtitleOverlaySettingsPage from './SubtitleOverlaySettingsPage';

const toggleSubtitleOverlayWindowMock = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../runtime/audio-runtime', () => ({
  toggleSubtitleOverlayWindow: (...args: unknown[]) => toggleSubtitleOverlayWindowMock(...args),
}));

function setInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  valueSetter?.call(input, value);
}

describe('SubtitleOverlaySettingsPage font size controls', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    toggleSubtitleOverlayWindowMock.mockReset();

    useAppStore.setState((state) => ({
      ...state,
      audioRuntimeSnapshot: structuredClone(audioRuntimeSnapshotMock),
      configDraft: structuredClone(appConfigDraftMock),
      runtimeNotifications: runtimeSnapshotMock.notifications,
      runtimeSnapshot: structuredClone(runtimeSnapshotMock),
    }));

    const overlayVisibleSnapshot = structuredClone(runtimeSnapshotMock);
    overlayVisibleSnapshot.windows = overlayVisibleSnapshot.windows.map((item) =>
      item.label === 'subtitle-overlay' ? { ...item, visible: true } : item,
    );
    toggleSubtitleOverlayWindowMock.mockResolvedValue(overlayVisibleSnapshot);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('updates large subtitle font size and overlay height from the appearance sliders', async () => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: { ...state.configDraft, subtitles: { ...state.configDraft.subtitles, overlayFontSize: 0 } },
    }));
    await act(async () => {
      root.render(
        <MemoryRouter>
          <SubtitleOverlaySettingsPage />
        </MemoryRouter>,
      );
    });

    const fontSizeSlider = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="range"]'))
      .find((input) => input.min === '16' && input.max === '96');
    const heightSlider = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="range"]'))
      .find((input) => input.min === '72' && input.max === '720');
    expect(fontSizeSlider).not.toBeUndefined();
    expect(heightSlider).not.toBeUndefined();

    await act(async () => {
      setInputValue(fontSizeSlider!, '72');
      fontSizeSlider!.dispatchEvent(new Event('input', { bubbles: true }));
      setInputValue(heightSlider!, '700');
      heightSlider!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(useAppStore.getState().configDraft.subtitles.overlayFontSize).toBe(72);
    expect(useAppStore.getState().configDraft.subtitles.overlayHeight).toBe(700);
    expect(container.textContent).toContain('settings.overlayPreviewTitle');
  });

  it('toggles the subtitle overlay window from the settings page action', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <SubtitleOverlaySettingsPage />
        </MemoryRouter>,
      );
    });

    const toggleButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      button.textContent?.includes('settings.overlayShowSubtitlesAction'),
    );
    expect(toggleButton).toBeDefined();

    await act(async () => {
      toggleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(toggleSubtitleOverlayWindowMock).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().runtimeSnapshot.windows.find((item) => item.label === 'subtitle-overlay')?.visible).toBe(true);
  });

  it('shows the overlay lock action before the subtitle visibility action', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <SubtitleOverlaySettingsPage />
        </MemoryRouter>,
      );
    });

    const actionButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('.settings-page-action-group button'));
    expect(actionButtons[0]?.textContent).toContain('audioRouting.restoreDefaults');
    expect(actionButtons[1]?.textContent).toContain('settings.overlayUnlockedState');
    expect(actionButtons[2]?.textContent).toContain('settings.overlayShowSubtitlesAction');

    await act(async () => {
      actionButtons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(useAppStore.getState().configDraft.subtitles.overlayLocked).toBe(true);
    expect(container.textContent).not.toContain('settings.overlayLockHint');
  });

  it('restores a recoverable overlay layout from the settings page', async () => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        subtitles: {
          ...state.configDraft.subtitles,
          overlayBackgroundColor: '#445566',
          overlayBackgroundOpacity: 0.2,
          overlayFontSize: 40,
          overlayHeight: 700,
          overlayLocked: true,
          overlayWidth: 1400,
          overlayX: 0,
          overlayY: 0,
        },
      },
    }));
    await act(async () => {
      root.render(
        <MemoryRouter>
          <SubtitleOverlaySettingsPage />
        </MemoryRouter>,
      );
    });

    const resetButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      button.textContent?.includes('audioRouting.restoreDefaults'),
    );
    await act(async () => resetButton?.click());

    expect(useAppStore.getState().configDraft.subtitles).toMatchObject({
      overlayBackgroundColor: '#111827',
      overlayBackgroundOpacity: 0.84,
      overlayFontSize: 24,
      overlayHeight: 220,
      overlayLocked: false,
      overlayWidth: 960,
      overlayX: 50,
      overlayY: 78,
    });
  });

  it('updates every appearance field from its form control', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <SubtitleOverlaySettingsPage />
        </MemoryRouter>,
      );
    });

    const ranges = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="range"]'));
    const colors = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="color"]'));
    await act(async () => {
      for (const [input, value] of ranges.map((input, index) => [input, String(index === 1 ? 33 : 0.5)] as const)) {
        setInputValue(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      for (const [input, value] of colors.map((input, index) => [input, index === 0 ? '#112233' : '#445566'] as const)) {
        setInputValue(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const select = container.querySelector<HTMLSelectElement>('select')!;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, select.options[1]!.value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const subtitles = useAppStore.getState().configDraft.subtitles;
    expect(subtitles.overlayOpacity).toBe(0.5);
    expect(subtitles.overlayFontSize).toBe(33);
    expect(subtitles.overlayTextColor).toBe('#112233');
    expect(subtitles.overlayBackgroundColor).toBe('#445566');
    expect(subtitles.overlayFontFamily).toContain('Microsoft YaHei');
  });

  it('shows pending text while the overlay visibility command is unresolved', async () => {
    let resolveToggle!: (snapshot: typeof runtimeSnapshotMock) => void;
    toggleSubtitleOverlayWindowMock.mockReturnValue(new Promise((resolve) => {
      resolveToggle = resolve;
    }));
    await act(async () => {
      root.render(
        <MemoryRouter>
          <SubtitleOverlaySettingsPage />
        </MemoryRouter>,
      );
    });

    const toggleButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      button.textContent?.includes('settings.overlayShowSubtitlesAction'),
    )!;
    await act(async () => {
      toggleButton.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('settings.overlayTogglePending');

    await act(async () => {
      resolveToggle(structuredClone(runtimeSnapshotMock));
      await Promise.resolve();
    });
  });
});
