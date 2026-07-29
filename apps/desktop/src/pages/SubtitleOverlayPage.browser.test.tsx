import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installDesktopApi, resetDesktopApiForTests } from '../runtime/desktop-api';
import { PreviewDesktopApi } from '../runtime/preview-desktop-api';
import { useAppStore } from '../stores/app-store';
import { registerDomHarness } from '../test-utils/component-test-harness';
import { findButtonByText } from '../test-utils/driver-store-fixtures';
import { seedRuntimeStore } from '../test-utils/store-seed';
import SubtitleOverlayPage from './SubtitleOverlayPage';

// This suite's subject is the BROWSER PREVIEW path, so the real runtime
// modules run against the real PreviewDesktopApi (installed below) instead of
// stubbing the runtime layer away. Only true leaf externalities are mocked.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/menu', () => ({ Menu: { new: vi.fn() } }));
vi.mock('@tauri-apps/api/window', () => ({
  PhysicalPosition: class PhysicalPosition {
    constructor(public x: number, public y: number) {}
  },
  currentMonitor: vi.fn(),
  cursorPosition: vi.fn(),
  getCurrentWindow: vi.fn(),
}));
vi.mock('react-i18next', async () =>
  (await import('../test-utils/i18n-stub')).reactI18nextStub({ passthroughDefault: true }));

describe('SubtitleOverlayPage browser preview interaction', () => {
  let container: HTMLDivElement;
  let previewApi: PreviewDesktopApi;

  const view = registerDomHarness({
    setup: () => {
      resetDesktopApiForTests();
      previewApi = new PreviewDesktopApi();
      installDesktopApi(previewApi);
      seedRuntimeStore((slices) => {
        slices.configDraft.subtitles.overlayLocked = false;
      });
    },
  });

  beforeEach(() => {
    ({ container } = view);
  });

  async function renderOverlay() {
    await view.render(<SubtitleOverlayPage />);
  }

  async function openContextMenu() {
    const overlay = container.querySelector('.subtitle-overlay-root');
    await act(async () => {
      overlay?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 9999, clientY: 9999 }));
    });
    expect(container.querySelector('.subtitle-overlay-context-menu')).not.toBeNull();
  }

  it('opens, dismisses and locks the browser context menu', async () => {
    await renderOverlay();
    await openContextMenu();
    const menu = container.querySelector('.subtitle-overlay-context-menu');
    await act(async () => {
      menu?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      menu?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    });
    expect(container.querySelector('.subtitle-overlay-context-menu')).not.toBeNull();

    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(container.querySelector('.subtitle-overlay-context-menu')).toBeNull();

    await openContextMenu();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    });
    expect(container.querySelector('.subtitle-overlay-context-menu')).toBeNull();

    await openContextMenu();
    await act(async () => findButtonByText(container, '锁定')?.click());
    expect(useAppStore.getState().configDraft.subtitles.overlayLocked).toBe(true);
    const overlay = container.querySelector('.subtitle-overlay-root');
    await act(async () => {
      overlay?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    expect(container.querySelector('.subtitle-overlay-context-menu')).toBeNull();
  });

  it('ignores outside menu events while the browser context menu is closed', async () => {
    await renderOverlay();

    await act(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    });

    expect(container.querySelector('.subtitle-overlay-context-menu')).toBeNull();
    expect(useAppStore.getState().configDraft.subtitles.overlayLocked).toBe(false);
  });

  it('applies every browser menu setting and closes the menu after each action', async () => {
    await renderOverlay();
    await openContextMenu();
    await act(async () => findButtonByText(container, '玻璃效果')?.click());
    expect(useAppStore.getState().configDraft.subtitles).toMatchObject({
      overlayBackgroundColor: '#0f172a',
      overlayBackgroundOpacity: 0.46,
      overlayOpacity: 0.82,
      overlayTextColor: '#f8fafc',
    });

    await openContextMenu();
    await act(async () => findButtonByText(container, '36px')?.click());
    expect(useAppStore.getState().configDraft.subtitles.overlayFontSize).toBe(36);

    await openContextMenu();
    await act(async () => findButtonByText(container, '25%')?.click());
    expect(useAppStore.getState().configDraft.subtitles.overlayBackgroundOpacity).toBe(0.25);

    await openContextMenu();
    await act(async () => findButtonByText(container, '天空蓝')?.click());
    expect(useAppStore.getState().configDraft.subtitles).toMatchObject({
      overlayTextColor: '#bae6fd',
      overlaySourceTextStyle: { color: '#bae6fd' },
      overlayTranslationTextStyle: { color: '#bae6fd' },
    });
  });

  it('falls back to the default preview font size when draft size is unset', async () => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        subtitles: {
          ...state.configDraft.subtitles,
          overlayFontSize: 0,
        },
      },
    }));

    await renderOverlay();

    expect(container.querySelector<HTMLElement>('.subtitle-overlay-source')?.style.fontSize).toBe('24px');
    expect(container.querySelector<HTMLElement>('.subtitle-overlay-translation')?.style.fontSize).toBe('20px');
  });

  it('keeps browser controls hidden while overlay is locked', async () => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        subtitles: {
          ...state.configDraft.subtitles,
          overlayLocked: true,
        },
      },
    }));

    await renderOverlay();
    const overlay = container.querySelector('.subtitle-overlay-root');
    await act(async () => {
      overlay?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      overlay?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });

    expect(findButtonByText(container, '解锁')).toBeUndefined();
    expect(container.querySelector('.subtitle-overlay-context-menu')).toBeNull();
    expect(useAppStore.getState().configDraft.subtitles.overlayLocked).toBe(true);
  });

  it('shows the hover lock control and forwards hide and clear actions', async () => {
    await renderOverlay();
    const overlay = container.querySelector('.subtitle-overlay-root');
    await act(async () => overlay?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(findButtonByText(container, '锁定')).not.toBeUndefined();
    await act(async () => overlay?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
    expect(findButtonByText(container, '锁定')).toBeUndefined();

    // Hide: the real runtime module drives the preview overlay implementation,
    // which flips the window's visibility and publishes the shell snapshot.
    const overlayVisibleBefore = useAppStore.getState().runtimeSnapshot.windows
      .find((item) => item.label === 'subtitle-overlay')?.visible;
    await openContextMenu();
    await act(async () => findButtonByText(container, '隐藏字幕悬浮窗')?.click());
    const overlayVisibleAfter = useAppStore.getState().runtimeSnapshot.windows
      .find((item) => item.label === 'subtitle-overlay')?.visible;
    expect(overlayVisibleAfter).toBe(!overlayVisibleBefore);

    // Clear: the preview implementation empties the cue store, and the page
    // publishes that snapshot (the fixture starts with one cue queued).
    expect(useAppStore.getState().audioRuntimeSnapshot.subtitleOverlay.recentCues.length).toBeGreaterThan(0);
    await openContextMenu();
    await act(async () => findButtonByText(container, '清空字幕')?.click());
    const clearedOverlay = useAppStore.getState().audioRuntimeSnapshot.subtitleOverlay;
    expect(clearedOverlay.recentCues).toEqual([]);
    expect(clearedOverlay.activeCue).toBeNull();
    expect(clearedOverlay.queueDepth).toBe(0);
  });

  it('publishes a visible session notification when clearing cues fails', async () => {
    vi.spyOn(previewApi.session, 'clearCues').mockRejectedValue(new Error('cue clear failed'));
    await renderOverlay();
    await openContextMenu();
    await act(async () => findButtonByText(container, '清空字幕')?.click());
    expect(useAppStore.getState().runtimeNotifications.some((item) => item.message.includes('cue clear failed'))).toBe(true);
  });
});
