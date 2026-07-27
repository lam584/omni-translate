import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { appConfigDraftMock } from '../mocks/app-config';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import { installDesktopApi, resetDesktopApiForTests } from '../runtime/desktop-api';
import { PreviewDesktopApi } from '../runtime/preview-desktop-api';
import { useAppStore } from '../stores/app-store';
import SubtitleOverlayPage from './SubtitleOverlayPage';

const runtimeMocks = vi.hoisted(() => ({
  clearSubtitleCuesRuntime: vi.fn(),
  toggleSubtitleOverlayWindow: vi.fn(),
}));

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
vi.mock('../runtime/audio-runtime', () => runtimeMocks);
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

function findButton(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.trim() === text);
}

describe('SubtitleOverlayPage browser preview interaction', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetDesktopApiForTests();
    installDesktopApi(new PreviewDesktopApi());
    runtimeMocks.clearSubtitleCuesRuntime.mockReset().mockResolvedValue(structuredClone(audioRuntimeSnapshotMock));
    runtimeMocks.toggleSubtitleOverlayWindow.mockReset().mockResolvedValue(structuredClone(runtimeSnapshotMock));
    useAppStore.setState((state) => ({
      ...state,
      audioRuntimeSnapshot: structuredClone(audioRuntimeSnapshotMock),
      configDraft: {
        ...structuredClone(appConfigDraftMock),
        subtitles: {
          ...structuredClone(appConfigDraftMock).subtitles,
          overlayLocked: false,
        },
      },
      runtimeSnapshot: structuredClone(runtimeSnapshotMock),
    }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function renderOverlay() {
    await act(async () => root.render(<SubtitleOverlayPage />));
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
    await act(async () => findButton(container, '锁定')?.click());
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
    await act(async () => findButton(container, '玻璃效果')?.click());
    expect(useAppStore.getState().configDraft.subtitles).toMatchObject({
      overlayBackgroundColor: '#0f172a',
      overlayBackgroundOpacity: 0.46,
      overlayOpacity: 0.82,
      overlayTextColor: '#f8fafc',
    });

    await openContextMenu();
    await act(async () => findButton(container, '36px')?.click());
    expect(useAppStore.getState().configDraft.subtitles.overlayFontSize).toBe(36);

    await openContextMenu();
    await act(async () => findButton(container, '25%')?.click());
    expect(useAppStore.getState().configDraft.subtitles.overlayBackgroundOpacity).toBe(0.25);

    await openContextMenu();
    await act(async () => findButton(container, '天空蓝')?.click());
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

    expect(findButton(container, '解锁')).toBeUndefined();
    expect(container.querySelector('.subtitle-overlay-context-menu')).toBeNull();
    expect(useAppStore.getState().configDraft.subtitles.overlayLocked).toBe(true);
  });

  it('shows the hover lock control and forwards hide and clear actions', async () => {
    await renderOverlay();
    const overlay = container.querySelector('.subtitle-overlay-root');
    await act(async () => overlay?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(findButton(container, '锁定')).not.toBeUndefined();
    await act(async () => overlay?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
    expect(findButton(container, '锁定')).toBeUndefined();

    await openContextMenu();
    await act(async () => findButton(container, '隐藏字幕悬浮窗')?.click());
    expect(runtimeMocks.toggleSubtitleOverlayWindow).toHaveBeenCalledTimes(1);

    await openContextMenu();
    await act(async () => findButton(container, '清空字幕')?.click());
    expect(runtimeMocks.clearSubtitleCuesRuntime).toHaveBeenCalledTimes(1);
  });

  it('publishes a visible session notification when clearing cues fails', async () => {
    runtimeMocks.clearSubtitleCuesRuntime.mockRejectedValue(new Error('cue clear failed'));
    await renderOverlay();
    await openContextMenu();
    await act(async () => findButton(container, '清空字幕')?.click());
    expect(useAppStore.getState().runtimeNotifications.some((item) => item.message.includes('cue clear failed'))).toBe(true);
  });
});
