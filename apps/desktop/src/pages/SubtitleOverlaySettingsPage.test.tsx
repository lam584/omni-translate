import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeBridge } from '../mocks/fake-bridge';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import { useAppStore } from '../stores/app-store';
import { buttonByText } from '../test-utils/dom-interactions';
import { registerFakeBridgeDomHarness } from '../test-utils/fake-bridge-dom-harness';
import { fakeBridgeHarness } from '../test-utils/fake-bridge-harness';
import SubtitleOverlaySettingsPage from './SubtitleOverlaySettingsPage';

// react-i18next stays stubbed (leaf externality: key passthrough keeps the
// assertions readable). The overlay command path is NOT stubbed: it runs the
// real audio-runtime module against the fake bridge contract double.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@tauri-apps/api/core', async () =>
  (await import('../test-utils/fake-bridge-harness')).fakeBridgeTauriCoreModule());

function setInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  valueSetter?.call(input, value);
}

describe('SubtitleOverlaySettingsPage font size controls', () => {
  let container: HTMLDivElement;
  let fake: FakeBridge;

  const harness = registerFakeBridgeDomHarness();
  const view = harness.view;

  beforeEach(() => {
    fake = harness.fake;
    ({ container } = view);
  });

  async function renderPage() {
    await view.render(
      <MemoryRouter>
        <SubtitleOverlaySettingsPage />
      </MemoryRouter>,
    );
  }

  function findOverlayToggleButton() {
    return buttonByText(container, 'settings.overlayShowSubtitlesAction');
  }

  it('updates large subtitle font size and overlay height from the appearance sliders', async () => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: { ...state.configDraft, subtitles: { ...state.configDraft.subtitles, overlayFontSize: 0 } },
    }));
    await renderPage();

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
    await renderPage();

    const toggleButton = findOverlayToggleButton();
    expect(toggleButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      toggleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // The real runtime module issued the native overlay toggle command...
    expect(fake.commandCalls('toggle_subtitle_overlay')).toHaveLength(1);
    expect(useAppStore.getState().runtimeSnapshot.windows.find((item) => item.label === 'subtitle-overlay')?.visible).toBe(true);
  });

  it('shows an inline error when toggling the subtitle overlay fails', async () => {
    fake.rejectNextAction('toggle_subtitle_overlay', { message: 'window unavailable' });
    await renderPage();
    const toggleButton = findOverlayToggleButton();
    await act(async () => toggleButton?.click());
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('session.overlayOpenFailed');
    expect(toggleButton?.disabled).toBe(false);
  });

  it('shows the overlay lock action before the subtitle visibility action', async () => {
    await renderPage();

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
    await renderPage();

    const resetButton = buttonByText(container, 'audioRouting.restoreDefaults');
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
    await renderPage();

    const fieldInput = <T extends HTMLInputElement | HTMLSelectElement>(labelKey: string, selector: string) =>
      Array.from(container.querySelectorAll<HTMLLabelElement>('label'))
        .find((label) => label.textContent?.includes(labelKey))?.querySelector<T>(selector);
    const fontSize = fieldInput<HTMLInputElement>('settings.overlayFontSizeLabel', 'input[type="range"]')!;
    const opacity = fieldInput<HTMLInputElement>('settings.overlayOpacityLabel', 'input[type="range"]')!;
    const textColor = fieldInput<HTMLInputElement>('settings.overlayTextColorLabel', 'input[type="color"]')!;
    const backgroundColor = fieldInput<HTMLInputElement>('settings.overlayBackgroundColorLabel', 'input[type="color"]')!;
    const font = fieldInput<HTMLSelectElement>('settings.overlayFontLabel', 'select')!;
    await act(async () => {
      for (const [input, value] of [[fontSize, '33'], [opacity, '50']] as const) {
        setInputValue(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      for (const [input, value] of [[textColor, '#112233'], [backgroundColor, '#445566']] as const) {
        setInputValue(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(font, font.options[1]!.value);
      font.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const subtitles = useAppStore.getState().configDraft.subtitles;
    expect(subtitles.overlayOpacity).toBe(0.5);
    expect(subtitles.overlayFontSize).toBe(33);
    expect(subtitles.overlayTextColor).toBe('#112233');
    expect(subtitles.overlayBackgroundColor).toBe('#445566');
    expect(subtitles.overlayFontFamily).toContain('Microsoft YaHei');
  });

  it('applies independent text effects and can copy them to both subtitle rows', async () => {
    await renderPage();

    const noneButton = buttonByText(container, 'settings.overlayEffectPreset.none')!;
    await act(async () => noneButton.click());

    let subtitles = useAppStore.getState().configDraft.subtitles;
    expect(subtitles.overlayTranslationTextStyle.outlineEnabled).toBe(false);
    expect(subtitles.overlayTranslationTextStyle.shadowEnabled).toBe(false);
    expect(subtitles.overlaySourceTextStyle.outlineEnabled).toBe(true);

    const applyBoth = buttonByText(container, 'settings.overlayApplyBoth')!;
    await act(async () => applyBoth.click());

    subtitles = useAppStore.getState().configDraft.subtitles;
    expect(subtitles.overlaySourceTextStyle).toEqual(subtitles.overlayTranslationTextStyle);
  });

  it('applies layout presets and alignment to the live preview', async () => {
    await renderPage();

    const lyricsPreset = buttonByText(container, 'settings.overlayPreset.lyrics')!;
    const leftAlign = buttonByText(container, 'settings.overlayAlign.left')!;
    await act(async () => {
      lyricsPreset.click();
      leftAlign.click();
    });

    const subtitles = useAppStore.getState().configDraft.subtitles;
    expect(subtitles.overlayBackgroundOpacity).toBe(0);
    expect(subtitles.overlayTextAlign).toBe('left');
    const preview = container.querySelector<HTMLElement>('.overlay-preview-window')!;
    expect(preview.style.getPropertyValue('--subtitle-overlay-text-align')).toBe('left');
  });

  it('shows pending text while the overlay visibility command is unresolved', async () => {
    // Hold the native toggle command unresolved to observe the pending UI.
    let resolveToggle!: (snapshot: typeof runtimeSnapshotMock) => void;
    fakeBridgeHarness.holdCommand = {
      command: 'toggle_subtitle_overlay',
      promise: new Promise((resolve) => { resolveToggle = resolve; }),
    };
    await renderPage();

    const toggleButton = findOverlayToggleButton()!;
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
