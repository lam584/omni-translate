import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { appConfigDraftMock } from '../mocks/app-config';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import { installDesktopApi, resetDesktopApiForTests, TauriDesktopApi } from '../runtime/desktop-api';
import { PreviewDesktopApi } from '../runtime/preview-desktop-api';
import SubtitleOverlayPage from './SubtitleOverlayPage';
import SubtitleOverlayContent from './overlay/SubtitleOverlayContent';
import { useAppStore } from '../stores/app-store';
import { mountTestRoot, type TestRootHandle } from '../test-utils/react-root';
import { cloneStoreState as cloneBaseStoreState } from '../test-utils/store-state';

const renderReceiptMocks = vi.hoisted(() => ({
  useOverlayRenderReceiptMock: vi.fn(),
}));

vi.mock('./overlay/useOverlayRenderReceipt', () => ({
  useOverlayRenderReceipt: renderReceiptMocks.useOverlayRenderReceiptMock,
}));

const tauriMocks = vi.hoisted(() => {
  let pointerPosition = { x: 0, y: 0 };

  return {

    currentMonitorMock: vi.fn(),
    cursorPositionMock: vi.fn(async () => ({ ...pointerPosition })),
    innerSizeMock: vi.fn(),
    invokeMock: vi.fn(),
    onResizedMock: vi.fn(),
    outerPositionMock: vi.fn(),
    outerSizeMock: vi.fn(),
    scaleFactorMock: vi.fn(),
    setDecorationsMock: vi.fn(),
    setIgnoreCursorEventsMock: vi.fn(),
    // Physical cursor coordinates. The unlock hotspot sits at the overlay's
    // top-right: with the window at (100,200) sized 1440x330 physical
    // (960x220 logical at scale 1.5), it spans x 1433.5..1531, y 209..263 —
    // hence the { x: 1480, y: 230 } probes below. { x: 220, y: 280 } is
    // inside the overlay but outside the hotspot; { x: 20, y: 20 } is outside
    // the overlay entirely.
    setPointerPosition: (next: { x: number; y: number }) => {
      pointerPosition = next;
    },
    setPositionMock: vi.fn(),
    setResizableMock: vi.fn(),
    setShadowMock: vi.fn(),
    setSizeMock: vi.fn(),
    startDraggingMock: vi.fn(),
    startResizeDraggingMock: vi.fn(),
  };
});

const menuMocks = vi.hoisted(() => ({
  closeMock: vi.fn(),
  newMock: vi.fn(),
  popupMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriMocks.invokeMock,
}));

vi.mock('@tauri-apps/api/dpi', () => ({
  LogicalPosition: class LogicalPosition {
    x: number;
    y: number;

    constructor(x: number, y: number) {
      this.x = x;
      this.y = y;
    }
  },
  LogicalSize: class LogicalSize {
    width: number;
    height: number;

    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
  },
}));

vi.mock('@tauri-apps/api/menu', () => ({
  Menu: {
    new: menuMocks.newMock,
  },
}));

vi.mock('@tauri-apps/api/window', () => {
  const windowHandle = {
    innerSize: tauriMocks.innerSizeMock,
    onResized: tauriMocks.onResizedMock,
    outerPosition: tauriMocks.outerPositionMock,
    outerSize: tauriMocks.outerSizeMock,
    scaleFactor: tauriMocks.scaleFactorMock,
    setDecorations: tauriMocks.setDecorationsMock,
    setIgnoreCursorEvents: tauriMocks.setIgnoreCursorEventsMock,
    setPosition: tauriMocks.setPositionMock,
    setResizable: tauriMocks.setResizableMock,
    setShadow: tauriMocks.setShadowMock,
    setSize: tauriMocks.setSizeMock,
    startDragging: tauriMocks.startDraggingMock,
    startResizeDragging: tauriMocks.startResizeDraggingMock,
  };

  return {
    PhysicalPosition: class PhysicalPosition {
      x: number;
      y: number;

      constructor(x: number, y: number) {
        this.x = x;
        this.y = y;
      }
    },
    currentMonitor: tauriMocks.currentMonitorMock,
    cursorPosition: tauriMocks.cursorPositionMock,
    getCurrentWindow: () => windowHandle,
  };
});

vi.mock('react-i18next', async () => (await import('../test-utils/i18n-stub')).reactI18nextStub());

// Variant of the shared helper: overlay tests start from a locked overlay.
function cloneStoreState() {
  const state = cloneBaseStoreState();
  state.configDraft.subtitles.overlayLocked = true;
  return state;
}

async function advanceLockedRevealPoll() {
  await act(async () => {
    vi.advanceTimersByTime(160);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function countSessionActionCalls(action: string) {
  return tauriMocks.invokeMock.mock.calls.filter(([command, args]) =>
    (command === 'session_v2' &&
      (args as { command?: { action?: string } } | undefined)?.command?.action === action) ||
    (command === 'sync_subtitle_overlay_window_state' && action === 'syncOverlayWindowState'),
  ).length;
}

function createPointerEvent(type: string, init?: PointerEventInit) {
  const PointerEventCtor = globalThis.PointerEvent ?? MouseEvent;
  return new PointerEventCtor(type, {
    bubbles: true,
    button: 0,
    pointerId: 1,
    ...init,
  } as PointerEventInit);
}

describe('SubtitleOverlayPage locked interaction', () => {
  let view: TestRootHandle;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    renderReceiptMocks.useOverlayRenderReceiptMock.mockReset();
    resetDesktopApiForTests();
    installDesktopApi(new TauriDesktopApi());

    if (!globalThis.PointerEvent) {
      Object.assign(globalThis, { PointerEvent: MouseEvent });
    }

    if (!HTMLElement.prototype.setPointerCapture) {
      HTMLElement.prototype.setPointerCapture = vi.fn();
    }

    if (!HTMLElement.prototype.releasePointerCapture) {
      HTMLElement.prototype.releasePointerCapture = vi.fn();
    }

    if (!HTMLElement.prototype.hasPointerCapture) {
      HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
    }

    tauriMocks.invokeMock.mockReset().mockImplementation(async (command: string) => {
      if (command === 'session_v2') {
        return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      }
      return undefined;
    });
    menuMocks.closeMock.mockReset().mockResolvedValue(undefined);
    menuMocks.popupMock.mockReset().mockResolvedValue(undefined);
    menuMocks.newMock.mockReset().mockResolvedValue({
      close: menuMocks.closeMock,
      popup: menuMocks.popupMock,
    });
    tauriMocks.currentMonitorMock.mockReset().mockResolvedValue({
      workArea: {
        position: { x: 0, y: 0 },
        size: { height: 1080, width: 1920 },
      },
    });
    tauriMocks.cursorPositionMock.mockReset().mockImplementation(async () => ({ x: 0, y: 0 }));
    tauriMocks.setDecorationsMock.mockReset().mockResolvedValue(undefined);
    tauriMocks.setIgnoreCursorEventsMock.mockReset().mockResolvedValue(undefined);
    tauriMocks.setPositionMock.mockReset().mockResolvedValue(undefined);
    tauriMocks.setResizableMock.mockReset().mockResolvedValue(undefined);
    tauriMocks.setShadowMock.mockReset().mockResolvedValue(undefined);
    tauriMocks.setSizeMock.mockReset().mockResolvedValue(undefined);
    tauriMocks.startDraggingMock.mockReset().mockResolvedValue(undefined);
    tauriMocks.startResizeDraggingMock.mockReset().mockResolvedValue(undefined);
    tauriMocks.outerPositionMock.mockReset().mockResolvedValue({ x: 100, y: 200 });
    // Physical sizes reported by the OS for the 960x220 LOGICAL draft at the
    // 1.5 scale factor above. Keeping these consistent matters: with a 1.0
    // fixture the logical and physical spaces coincide, so a missing
    // physical->logical conversion is undetectable.
    tauriMocks.outerSizeMock.mockReset().mockResolvedValue({ height: 330, width: 1440 });
    tauriMocks.innerSizeMock.mockReset().mockResolvedValue({ height: 330, width: 1440 });
    tauriMocks.onResizedMock.mockReset().mockResolvedValue(() => undefined);
    // HiDPI by default: overlay geometry mixes logical sizes with physical
    // cursor/window coordinates, and a 1.0 fixture hides scale mistakes.
    tauriMocks.scaleFactorMock.mockReset().mockResolvedValue(1.5);

    const { audioRuntimeSnapshot, configDraft, runtimeSnapshot } = cloneStoreState();
    useAppStore.setState((state) => ({
      ...state,
      audioRuntimeSnapshot,
      configDraft,
      runtimeNotifications: runtimeSnapshot.notifications,
      runtimeSnapshot,
    }));

    tauriMocks.setPointerPosition({ x: 20, y: 20 });
    tauriMocks.cursorPositionMock.mockImplementation(async () => ({ x: 20, y: 20 }));
    view = mountTestRoot();
    ({ container } = view);
  });

  afterEach(async () => {
    await view.cleanup();
    vi.useRealTimers();
  });

  it('directly synchronizes the initial locked state to the native overlay window', async () => {
    await view.render(<SubtitleOverlayPage />);

    expect(tauriMocks.invokeMock).toHaveBeenCalledWith(
      'sync_subtitle_overlay_window_state',
      expect.objectContaining({ locked: true, hotspotInteractive: false }),
    );
  });

  it('wires displayed cues and the report session into DOM render receipts', async () => {
    useAppStore.setState((state) => ({
      ...state,
      audioRuntimeSnapshot: {
        ...state.audioRuntimeSnapshot,
        subtitleOverlay: {
          ...state.audioRuntimeSnapshot.subtitleOverlay,
          reportSessionId: 'watch-session-live-translate',
        },
      },
    }));

    await view.render(<SubtitleOverlayPage />);

    expect(renderReceiptMocks.useOverlayRenderReceiptMock).toHaveBeenLastCalledWith({
      desktopApi: expect.any(TauriDesktopApi),
      displayCues: [...audioRuntimeSnapshotMock.subtitleOverlay.recentCues].reverse(),
      reportSessionId: 'watch-session-live-translate',
    });
  });

  it('reveals the unlock button when the cursor enters the overlay bounds but keeps cursor passthrough outside the button hotspot', async () => {
    await view.render(<SubtitleOverlayPage />);

    expect(container.querySelector('.subtitle-overlay-toggle-lock')).toBeNull();

    tauriMocks.setPointerPosition({ x: 220, y: 280 });
    tauriMocks.cursorPositionMock.mockImplementation(async () => ({ x: 220, y: 280 }));
    await advanceLockedRevealPoll();

    expect(container.querySelector('.subtitle-overlay-toggle-lock')).not.toBeNull();
  });

  it('syncs overlay border opacity with background opacity', async () => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        subtitles: {
          ...state.configDraft.subtitles,
          overlayBackgroundOpacity: 0,
          overlayOpacity: 0.85,
        },
      },
    }));

    await view.render(<SubtitleOverlayPage />);

    const lyrics = container.querySelector<HTMLElement>('.subtitle-overlay-lyrics');
    expect(lyrics?.style.getPropertyValue('--subtitle-overlay-background')).toBe('rgba(17, 24, 39, 0)');
    expect(lyrics?.style.getPropertyValue('--subtitle-overlay-border')).toBe('rgba(255, 255, 255, 0)');
    expect(lyrics?.style.getPropertyValue('--subtitle-overlay-shadow')).toBe('rgba(0, 0, 0, 0)');
    expect(lyrics?.style.getPropertyValue('--subtitle-overlay-blur')).toBe('0px');
  });

  it('stops passthrough inside the unlock hotspot and unlocks the overlay when the button is clicked', async () => {
    await view.render(<SubtitleOverlayPage />);

    tauriMocks.setPointerPosition({ x: 1480, y: 230 });
    tauriMocks.cursorPositionMock.mockImplementation(async () => ({ x: 1480, y: 230 }));
    await advanceLockedRevealPoll();

    const button = container.querySelector('.subtitle-overlay-toggle-lock');
    expect(button).not.toBeNull();
    expect(tauriMocks.invokeMock).toHaveBeenCalledWith(
      'sync_subtitle_overlay_window_state',
      expect.objectContaining({ locked: true, hotspotInteractive: true }),
    );
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(useAppStore.getState().configDraft.subtitles.overlayLocked).toBe(false);
    expect(tauriMocks.invokeMock).toHaveBeenCalledWith('unlock_subtitle_overlay');
  });

  it('toggles a locked browser-preview overlay without invoking the native unlock command', async () => {
    installDesktopApi(new PreviewDesktopApi());
    useAppStore.setState((state) => ({ ...state, configDraft: { ...state.configDraft,
      subtitles: { ...state.configDraft.subtitles, overlayLocked: false } } }));
    await view.render(<SubtitleOverlayPage />);
    const overlay = container.querySelector<HTMLElement>('.subtitle-overlay-root')!;
    await act(async () => overlay.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    const button = container.querySelector<HTMLButtonElement>('.subtitle-overlay-toggle-lock');
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    expect(useAppStore.getState().configDraft.subtitles.overlayLocked).toBe(true);
    expect(tauriMocks.invokeMock).not.toHaveBeenCalledWith('unlock_subtitle_overlay');
  });

  it('restores cursor passthrough when the cursor leaves the unlock hotspot', async () => {
    await view.render(<SubtitleOverlayPage />);

    tauriMocks.setPointerPosition({ x: 1480, y: 230 });
    tauriMocks.cursorPositionMock.mockImplementation(async () => ({ x: 1480, y: 230 }));
    await advanceLockedRevealPoll();

    tauriMocks.setPointerPosition({ x: 220, y: 280 });
    tauriMocks.cursorPositionMock.mockImplementation(async () => ({ x: 220, y: 280 }));
    await advanceLockedRevealPoll();

    const nativeStateCalls = tauriMocks.invokeMock.mock.calls.filter(
      ([command]) => command === 'sync_subtitle_overlay_window_state',
    );
    expect(nativeStateCalls.some(([, args]) => (
      (args as { hotspotInteractive?: boolean }).hotspotInteractive === true
    ))).toBe(true);
    expect(nativeStateCalls.at(-1)?.[1]).toEqual(
      expect.objectContaining({ locked: true, hotspotInteractive: false }),
    );
  });

  it('reports native unlock persistence failures, including non-Error IPC values', async () => {
    tauriMocks.invokeMock.mockImplementation(async (command: string) => {
      if (command === 'unlock_subtitle_overlay') throw 'native offline';
      if (command === 'session_v2') return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      return undefined;
    });
    await view.render(<SubtitleOverlayPage />);
    tauriMocks.setPointerPosition({ x: 220, y: 280 });
    tauriMocks.cursorPositionMock.mockResolvedValue({ x: 220, y: 280 });
    await advanceLockedRevealPoll();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.subtitle-overlay-toggle-lock')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useAppStore.getState().runtimeNotifications[0]?.message).toContain('native offline');
    expect(useAppStore.getState().runtimeNotifications[0]?.source).toBe('session');
    expect(useAppStore.getState().configDraft.subtitles.overlayLocked).toBe(true);
  });

  it('reports Error instances from native unlock persistence', async () => {
    tauriMocks.invokeMock.mockImplementation(async (command: string) => {
      if (command === 'unlock_subtitle_overlay') throw new Error('native error failure');
      if (command === 'session_v2') return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      return undefined;
    });
    await view.render(<SubtitleOverlayPage />);
    tauriMocks.cursorPositionMock.mockResolvedValue({ x: 220, y: 280 });
    await advanceLockedRevealPoll();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.subtitle-overlay-toggle-lock')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useAppStore.getState().runtimeNotifications[0]?.message).toContain('native error failure');
  });

  it('ignores hover state changes while the overlay remains locked', async () => {
    await view.render(<SubtitleOverlayPage />);
    const overlay = container.querySelector<HTMLElement>('.subtitle-overlay-root')!;
    await act(async () => {
      overlay.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      overlay.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(container.querySelector('.subtitle-overlay-root-locked')).toBeInstanceOf(HTMLElement);
  });

  it('shows and hides the lock action while an unlocked overlay is hovered', async () => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: { ...state.configDraft, subtitles: { ...state.configDraft.subtitles, overlayLocked: false } },
    }));
    await view.render(<SubtitleOverlayPage />);
    const overlay = container.querySelector<HTMLElement>('.subtitle-overlay-root')!;
    await act(async () => overlay.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    const button = container.querySelector<HTMLButtonElement>('.subtitle-overlay-toggle-lock');
    expect(button).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      button?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      button?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    await act(async () => button?.click());
    expect(tauriMocks.invokeMock).not.toHaveBeenCalledWith('unlock_subtitle_overlay');
    useAppStore.getState().updateSubtitleDraft({ overlayLocked: false });
    await act(async () => overlay.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
  });

  it('re-syncs native window state only once when the lock button toggles overlayLocked', async () => {
    await view.render(<SubtitleOverlayPage />);

    tauriMocks.setPointerPosition({ x: 1480, y: 230 });
    tauriMocks.cursorPositionMock.mockImplementation(async () => ({ x: 1480, y: 230 }));
    await advanceLockedRevealPoll();

    const windowStateSyncCallsBeforeClick = countSessionActionCalls('syncOverlayWindowState');
    const button = container.querySelector('.subtitle-overlay-toggle-lock');
    expect(button).not.toBeNull();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(countSessionActionCalls('syncOverlayWindowState')).toBe(windowStateSyncCallsBeforeClick + 1);
  });

  it('resizes the overlay from client-area handles after unlock without using native resize dragging', async () => {
    await view.render(<SubtitleOverlayPage />);

    await act(async () => {
      useAppStore.setState((state) => ({
        ...state,
        configDraft: {
          ...state.configDraft,
          subtitles: {
            ...state.configDraft.subtitles,
            overlayLocked: false,
          },
        },
      }));
    });

    await view.render(<SubtitleOverlayPage />);

    const eastHandle = container.querySelector('.subtitle-overlay-resize-handle-east');
    expect(eastHandle).not.toBeNull();

    await act(async () => {
      eastHandle?.dispatchEvent(createPointerEvent('pointerdown', { pointerId: 7, screenX: 1060, screenY: 310 }));
      await Promise.resolve();
    });

    await act(async () => {
      eastHandle?.dispatchEvent(createPointerEvent('pointermove', { pointerId: 7, screenX: 1120, screenY: 310 }));
      await Promise.resolve();
    });

    await act(async () => {
      eastHandle?.dispatchEvent(createPointerEvent('pointerup', { pointerId: 7, screenX: 1120, screenY: 310 }));
    });

    expect(tauriMocks.setSizeMock).toHaveBeenCalled();
    expect(tauriMocks.setPositionMock).toHaveBeenCalled();
    expect(tauriMocks.startResizeDraggingMock).not.toHaveBeenCalled();
    // 60 screen px dragged east = round(60 * 1.5) = 90 physical px added to the
    // 1440-physical-px window, persisted back as round(1530 / 1.5) logical px.
    expect(useAppStore.getState().configDraft.subtitles.overlayWidth).toBe(1_020);
  });

  it('opens the native context menu and executes style and lock callbacks', async () => {
    tauriMocks.invokeMock.mockImplementation(async (command: string) => {
      if (command === 'toggle_subtitle_overlay') {
        return structuredClone(runtimeSnapshotMock);
      }

      if (command === 'session_v2') {
        return { data: structuredClone(audioRuntimeSnapshotMock), warnings: [] };
      }

      return undefined;
    });
    menuMocks.closeMock.mockRejectedValueOnce(new Error('menu already closed'));
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        subtitles: {
          ...state.configDraft.subtitles,
          overlayLocked: false,
        },
      },
    }));
    await view.render(<SubtitleOverlayPage />);

    const overlay = container.querySelector('.subtitle-overlay-root');
    await act(async () => {
      overlay?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 30 }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(menuMocks.newMock).toHaveBeenCalledTimes(1);
    expect(menuMocks.popupMock).toHaveBeenCalledTimes(1);
    expect(menuMocks.closeMock).toHaveBeenCalledTimes(1);

    const items = menuMocks.newMock.mock.calls[0][0].items;
    await act(async () => {
      items[0].items[1].action();
      items[1].items[3].action();
      items[2].items[1].action();
      items[3].items[4].action();
      items[5].action();
      items[6].action();
      items[7].action();
      await Promise.resolve();
    });
    expect(useAppStore.getState().configDraft.subtitles).toMatchObject({
      overlayBackgroundColor: '#0f172a',
      overlayFontSize: 28,
      overlayBackgroundOpacity: 0.25,
      overlayTextColor: '#bae6fd',
      overlayLocked: true,
    });
    expect(tauriMocks.invokeMock).toHaveBeenCalledWith('toggle_subtitle_overlay');
    expect(countSessionActionCalls('clearCues')).toBe(1);
  });

  it('drags an unlocked overlay and ignores unrelated pointer ids', async () => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        subtitles: {
          ...state.configDraft.subtitles,
          overlayLocked: false,
        },
      },
    }));
    await view.render(<SubtitleOverlayPage />);
    const overlay = container.querySelector('.subtitle-overlay-root');
    await act(async () => {
      overlay?.dispatchEvent(createPointerEvent('pointermove', { pointerId: 99, screenX: 1, screenY: 1 }));
      overlay?.dispatchEvent(createPointerEvent('pointerup', { pointerId: 99, screenX: 1, screenY: 1 }));
      overlay?.dispatchEvent(createPointerEvent('pointerdown', { pointerId: 9, screenX: 100, screenY: 200 }));
      await Promise.resolve();
    });
    await act(async () => {
      overlay?.dispatchEvent(createPointerEvent('pointermove', { pointerId: 9, screenX: 180, screenY: 260 }));
      vi.advanceTimersByTime(20);
      await Promise.resolve();
    });
    await act(async () => {
      overlay?.dispatchEvent(createPointerEvent('pointerup', { pointerId: 9, screenX: 180, screenY: 260 }));
    });
    expect(tauriMocks.setPositionMock).toHaveBeenCalled();
    expect(useAppStore.getState().configDraft.subtitles.overlayX).not.toBe(appConfigDraftMock.subtitles.overlayX);
  });

  it('finishes overlay and resize drags through pointer cancellation', async () => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        subtitles: {
          ...state.configDraft.subtitles,
          overlayLocked: false,
        },
      },
    }));
    await view.render(<SubtitleOverlayPage />);

    const overlay = container.querySelector('.subtitle-overlay-root');
    const eastHandle = container.querySelector('.subtitle-overlay-resize-handle-east');
    await act(async () => {
      overlay?.dispatchEvent(createPointerEvent('pointerdown', { pointerId: 10, screenX: 100, screenY: 200 }));
      await Promise.resolve();
      overlay?.dispatchEvent(createPointerEvent('pointercancel', { pointerId: 10, screenX: 140, screenY: 240 }));
      eastHandle?.dispatchEvent(createPointerEvent('pointerdown', { pointerId: 11, screenX: 1060, screenY: 310 }));
      await Promise.resolve();
      eastHandle?.dispatchEvent(createPointerEvent('pointercancel', { pointerId: 11, screenX: 1100, screenY: 310 }));
    });

    expect(tauriMocks.setPositionMock).toHaveBeenCalled();
    expect(tauriMocks.setSizeMock).toHaveBeenCalled();
  });

  it('updates the draft after native resizes and cancels pending work on cleanup', async () => {
    let onResized: (() => Promise<void>) | undefined;
    const unlisten = vi.fn();
    tauriMocks.onResizedMock.mockImplementation(async (callback: () => Promise<void>) => {
      onResized = callback;
      return unlisten;
    });
    tauriMocks.innerSizeMock.mockResolvedValue({ height: 180, width: 720 });

    await act(async () => {
      view.root.render(<SubtitleOverlayPage />);
      await Promise.resolve();
    });
    expect(onResized).toBeTypeOf('function');

    await act(async () => {
      await onResized?.();
      await onResized?.();
      await onResized?.();
      vi.advanceTimersByTime(301);
      await Promise.resolve();
      await Promise.resolve();
    });
    // 720x180 PHYSICAL px reported by the OS becomes 480x120 LOGICAL px in the
    // persisted draft (round(physical / 1.5)). At the previous 1.0 fixture the
    // expectation was 720x180, which passes whether or not the code divides by
    // the scale factor at all.
    expect(useAppStore.getState().configDraft.subtitles).toMatchObject({
      overlayHeight: 120,
      overlayWidth: 480,
    });

    tauriMocks.currentMonitorMock.mockResolvedValueOnce(null);
    await act(async () => {
      await onResized?.();
      vi.advanceTimersByTime(301);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await onResized?.();
      view.root.unmount();
    });
    expect(unlisten).toHaveBeenCalled();
  });

  it('runs locked reveal button hover and blur handlers', async () => {
    await view.render(<SubtitleOverlayPage />);
    tauriMocks.setPointerPosition({ x: 1480, y: 230 });
    tauriMocks.cursorPositionMock.mockImplementation(async () => ({ x: 1480, y: 230 }));
    await advanceLockedRevealPoll();

    const button = container.querySelector('.subtitle-overlay-toggle-lock');
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      button?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      button?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      button?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(button).not.toBeNull();
  });

  it('flushes client resize bounds through animation frames and ignores a missing monitor', async () => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        subtitles: {
          ...state.configDraft.subtitles,
          overlayLocked: false,
        },
      },
    }));
    tauriMocks.currentMonitorMock.mockResolvedValueOnce(null);
    await act(async () => {
      view.root.render(<SubtitleOverlayPage />);
      await Promise.resolve();
    });

    const eastHandle = container.querySelector('.subtitle-overlay-resize-handle-east');
    await act(async () => {
      eastHandle?.dispatchEvent(createPointerEvent('pointerdown', { pointerId: 12, screenX: 1060, screenY: 310 }));
      await Promise.resolve();
      eastHandle?.dispatchEvent(createPointerEvent('pointermove', { pointerId: 12, screenX: 1130, screenY: 310 }));
      vi.advanceTimersByTime(20);
      await Promise.resolve();
    });
    expect(tauriMocks.setSizeMock).toHaveBeenCalled();
  });

  it('hides a revealed lock button when native cursor polling fails', async () => {
    await view.render(<SubtitleOverlayPage />);
    tauriMocks.setPointerPosition({ x: 1480, y: 230 });
    tauriMocks.cursorPositionMock.mockResolvedValue({ x: 1480, y: 230 });
    await advanceLockedRevealPoll();
    expect(container.querySelector('.subtitle-overlay-toggle-lock')).not.toBeNull();

    tauriMocks.cursorPositionMock.mockRejectedValueOnce(new Error('cursor unavailable'));
    await advanceLockedRevealPoll();
    expect(container.querySelector('.subtitle-overlay-toggle-lock')).toBeNull();
  });

  it('restores document and app-root styles after unmount', async () => {
    const appRoot = document.createElement('div');
    appRoot.id = 'root';
    appRoot.setAttribute('style', 'color: red');
    document.body.appendChild(appRoot);
    document.documentElement.setAttribute('style', 'color: blue');
    document.body.setAttribute('style', 'color: green');

    await view.render(<SubtitleOverlayPage />);
    await act(async () => {
      view.root.unmount();
    });

    expect(document.documentElement.getAttribute('style')).toContain('color: blue');
    expect(document.body.getAttribute('style')).toContain('color: green');
    expect(appRoot.getAttribute('style')).toContain('color: red');
    appRoot.remove();
    document.documentElement.removeAttribute('style');
    document.body.removeAttribute('style');
  });

  it('prefers displaySourceText and preserves multiline subtitles', async () => {
    useAppStore.setState((state) => {
      const nextSnapshot = structuredClone(state.audioRuntimeSnapshot);
      const cue = nextSnapshot.subtitleOverlay.recentCues[0];
      cue.sourceText = 'Raw long source that should not be displayed';
      cue.displaySourceText = 'First source line\nSecond source line';
      cue.translatedText = '第一行\n第二行';
      cue.displaySegments = undefined;
      nextSnapshot.subtitleOverlay.activeCue = cue;

      return {
        ...state,
        audioRuntimeSnapshot: nextSnapshot,
      };
    });

    await view.render(<SubtitleOverlayPage />);

    expect(container.textContent).toContain('First source line');
    expect(container.textContent).toContain('Second source line');
    expect(container.textContent).toContain('第一行');
    expect(container.textContent).not.toContain('Raw long source that should not be displayed');
  });

  it('renders display segments as paired source and translation rows', async () => {
    useAppStore.setState((state) => {
      const nextSnapshot = structuredClone(state.audioRuntimeSnapshot);
      const cue = nextSnapshot.subtitleOverlay.recentCues[0];
      cue.sourceText = 'Raw long source that should not be displayed';
      cue.displaySourceText = 'First source\nSecond source';
      cue.translatedText = '第一句\n第二句';
      cue.displaySegments = [
        { sourceText: 'First source', translatedText: '第一句', pending: false },
        { sourceText: 'Second source', translatedText: '第二句', pending: false },
      ];
      nextSnapshot.subtitleOverlay.activeCue = cue;

      return {
        ...state,
        audioRuntimeSnapshot: nextSnapshot,
      };
    });

    await view.render(<SubtitleOverlayPage />);

    const segmentTexts = Array.from(container.querySelectorAll('.subtitle-overlay-segment')).map((segment) => segment.textContent);
    expect(segmentTexts).toEqual(['First source第一句', 'Second source第二句']);
  });

  it('keeps unfinished text in the fixed stream slot below finalized subtitles', async () => {
    useAppStore.setState((state) => {
      const nextSnapshot = structuredClone(state.audioRuntimeSnapshot);
      const cue = nextSnapshot.subtitleOverlay.recentCues[0];
      cue.displaySegments = [
        { sourceText: 'Already translated source', translatedText: '已有译文', pending: false },
        { sourceText: 'Waiting source', translatedText: '', pending: true },
      ];
      cue.displaySourceText = 'Already translated source\nWaiting source';
      cue.sourceText = cue.displaySourceText;
      cue.translatedText = '已有译文';
      cue.committed = false;
      nextSnapshot.subtitleOverlay.activeCue = cue;

      return {
        ...state,
        audioRuntimeSnapshot: nextSnapshot,
      };
    });

    await view.render(<SubtitleOverlayPage />);

    const segments = Array.from(container.querySelectorAll('.subtitle-overlay-segment'));
    expect(segments).toHaveLength(1);
    expect(segments[0].textContent).toContain('已有译文');
    expect(container.querySelector('.subtitle-overlay-stream-slot')?.textContent).toContain('Waiting source');
    expect(container.querySelector('.subtitle-overlay-stream-slot')?.className).toContain('subtitle-overlay-stream-slot-active');
  });

  it('renders every token in the bottom slot and moves the finalized sentence one row up', async () => {
    const updateStreamingCue = async (translatedText: string, pending: boolean) => {
      await act(async () => {
        useAppStore.setState((state) => {
          const nextSnapshot = structuredClone(state.audioRuntimeSnapshot);
          const cue = nextSnapshot.subtitleOverlay.recentCues[0];
          cue.displaySourceText = 'Streaming source';
          cue.sourceText = 'Streaming source';
          cue.translatedText = translatedText;
          cue.displaySegments = [{ sourceText: 'Streaming source', translatedText, pending }];
          cue.committed = !pending;
          nextSnapshot.subtitleOverlay.activeCue = cue;
          return { ...state, audioRuntimeSnapshot: nextSnapshot };
        });
      });
    };

    await updateStreamingCue('你', true);
    await view.render(<SubtitleOverlayPage />);
    expect(container.querySelector('.subtitle-overlay-stream-text')?.textContent).toBe('你');
    expect(container.querySelectorAll('.subtitle-overlay-segment')).toHaveLength(0);

    await updateStreamingCue('你好', true);
    expect(container.querySelector('.subtitle-overlay-stream-text')?.textContent).toBe('你好');
    expect(container.querySelectorAll('.subtitle-overlay-segment')).toHaveLength(0);

    await updateStreamingCue('你好。', false);
    const historySegment = container.querySelector('.subtitle-overlay-segment');
    const streamSlot = container.querySelector('.subtitle-overlay-stream-slot');
    expect(historySegment?.textContent).toContain('你好。');
    expect(streamSlot?.textContent?.trim()).toBe('');
    if (!historySegment || !streamSlot) {
      throw new Error('finalized history and live stream slot should both render');
    }
    expect(
      historySegment.compareDocumentPosition(streamSlot) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    await act(async () => {
      useAppStore.setState((state) => {
        const nextSnapshot = structuredClone(state.audioRuntimeSnapshot);
        const cue = nextSnapshot.subtitleOverlay.recentCues[0];
        cue.displaySourceText = 'Streaming source\nNext source';
        cue.sourceText = cue.displaySourceText;
        cue.translatedText = '你好。\n下';
        cue.displaySegments = [
          { sourceText: 'Streaming source', translatedText: '你好。', pending: false },
          { sourceText: 'Next source', translatedText: '下', pending: true },
        ];
        cue.committed = false;
        nextSnapshot.subtitleOverlay.activeCue = cue;
        return { ...state, audioRuntimeSnapshot: nextSnapshot };
      });
    });
    expect(container.querySelector('.subtitle-overlay-segment')?.textContent).toContain('你好。');
    expect(container.querySelector('.subtitle-overlay-stream-text')?.textContent).toBe('下');
  });

  it('shows the pending source and its partial translation on separate stream rows', async () => {
    useAppStore.setState((state) => {
      const nextSnapshot = structuredClone(state.audioRuntimeSnapshot);
      const cue = nextSnapshot.subtitleOverlay.recentCues[0];
      cue.sourceText = 'Waiting source';
      cue.displaySourceText = 'Waiting source';
      cue.translatedText = '部分译文';
      cue.displaySegments = [{ sourceText: 'Waiting source', translatedText: '部分译文', pending: true }];
      cue.committed = false;
      nextSnapshot.subtitleOverlay.activeCue = cue;
      return { ...state, audioRuntimeSnapshot: nextSnapshot };
    });

    await view.render(<SubtitleOverlayPage />);

    expect(container.querySelector('.subtitle-overlay-stream-source')?.textContent).toBe('Waiting source');
    expect(container.querySelector('.subtitle-overlay-stream-text')?.textContent).toBe('部分译文');
    expect(container.querySelector('.subtitle-overlay-stream-slot')?.className).toContain('subtitle-overlay-stream-slot-active');
  });

  it('streams independently pending Omni source and translation tails without duplicating history', async () => {
    const sourceLines = [
      'Omni source line one',
      'Omni source line two',
      'Omni source line three',
      'Omni source line four',
    ];
    const translationSteps = [
      ['Omni 译文一'],
      ['Omni 译文一', 'Omni 译文二'],
      ['Omni 译文一', 'Omni 译文二', 'Omni 译文三'],
    ];
    const updateOmniSegments = async (translatedLines: string[], committed = false) => {
      await act(async () => {
        useAppStore.setState((state) => {
          const nextSnapshot = structuredClone(state.audioRuntimeSnapshot);
          const cue = nextSnapshot.subtitleOverlay.recentCues[0];
          cue.sourceText = sourceLines.join('\n');
          cue.displaySourceText = cue.sourceText;
          cue.translatedText = translatedLines.join('\n');
          cue.displaySegments = sourceLines.map((sourceText, index) => ({
            sourceText,
            translatedText: translatedLines[index] ?? '',
            pending: !committed && (
              index === sourceLines.length - 1 || index === translatedLines.length - 1
            ),
          }));
          cue.committed = committed;
          nextSnapshot.subtitleOverlay.activeCue = cue;
          return { ...state, audioRuntimeSnapshot: nextSnapshot };
        });
      });
    };
    const expectStreamingStep = (translatedLines: string[]) => {
      const latestTranslation = translatedLines.at(-1);
      const historyTranslations = Array.from(
        container.querySelectorAll('.subtitle-overlay-history .subtitle-overlay-translation'),
      ).map((element) => element.textContent).filter(Boolean);

      expect(container.querySelector('.subtitle-overlay-stream-source')?.textContent).toBe(sourceLines.at(-1));
      expect(container.querySelector('.subtitle-overlay-stream-text')?.textContent).toBe(latestTranslation);
      expect(historyTranslations).toEqual(translatedLines.slice(0, -1));
      expect(container.querySelector('.subtitle-overlay-history')?.textContent).not.toContain(latestTranslation);
    };

    await updateOmniSegments(translationSteps[0]);
    await view.render(<SubtitleOverlayPage />);
    expectStreamingStep(translationSteps[0]);

    await updateOmniSegments(translationSteps[1]);
    expectStreamingStep(translationSteps[1]);

    await updateOmniSegments(translationSteps[2]);
    expectStreamingStep(translationSteps[2]);

    await updateOmniSegments(translationSteps[2], true);
    expect(container.querySelector('.subtitle-overlay-stream-slot')?.textContent?.trim()).toBe('');
    expect(Array.from(
      container.querySelectorAll('.subtitle-overlay-history .subtitle-overlay-translation'),
    ).map((element) => element.textContent).filter(Boolean)).toEqual(translationSteps[2]);
  });

  it('keeps an uncommitted Omni fallback cue in the live rows while both hypotheses iterate', async () => {
    const updateOmniCue = async (sourceText: string, translatedText: string, committed: boolean) => {
      await act(async () => {
        useAppStore.setState((state) => {
          const nextSnapshot = structuredClone(state.audioRuntimeSnapshot);
          const cue = nextSnapshot.subtitleOverlay.recentCues[0];
          cue.sourceText = sourceText;
          cue.displaySourceText = '';
          cue.translatedText = translatedText;
          cue.displaySegments = [];
          cue.committed = committed;
          nextSnapshot.subtitleOverlay.activeCue = cue;
          return { ...state, audioRuntimeSnapshot: nextSnapshot };
        });
      });
    };

    await updateOmniCue('Hello wor', 'Ni', false);
    await view.render(<SubtitleOverlayPage />);
    expect(container.querySelector('.subtitle-overlay-stream-source')?.textContent).toBe('Hello wor');
    expect(container.querySelector('.subtitle-overlay-stream-text')?.textContent).toBe('Ni');
    expect(container.querySelectorAll('.subtitle-overlay-segment')).toHaveLength(0);

    await updateOmniCue('Hello world', 'Ni hao', false);
    expect(container.querySelector('.subtitle-overlay-stream-source')?.textContent).toBe('Hello world');
    expect(container.querySelector('.subtitle-overlay-stream-text')?.textContent).toBe('Ni hao');
    expect(container.querySelectorAll('.subtitle-overlay-segment')).toHaveLength(0);

    await updateOmniCue('Hello world', 'Ni hao', true);
    expect(container.querySelector('.subtitle-overlay-segment')?.textContent).toContain('Hello world');
    expect(container.querySelector('.subtitle-overlay-stream-slot')?.textContent?.trim()).toBe('');
  });

  it('promotes completed sentences during a fast uncommitted burst and keeps only its tail live', async () => {
    const updateBurst = async (sourceText: string, translatedText: string) => {
      await act(async () => {
        useAppStore.setState((state) => {
          const nextSnapshot = structuredClone(state.audioRuntimeSnapshot);
          const cue = nextSnapshot.subtitleOverlay.recentCues[0];
          cue.sourceText = sourceText;
          cue.displaySourceText = '';
          cue.translatedText = translatedText;
          cue.displaySegments = [];
          cue.committed = false;
          nextSnapshot.subtitleOverlay.activeCue = cue;
          return { ...state, audioRuntimeSnapshot: nextSnapshot };
        });
      });
    };

    await updateBurst(
      'First source. Second source is still live',
      '第一句。第二句仍在输出',
    );
    await view.render(<SubtitleOverlayPage />);

    expect(Array.from(container.querySelectorAll('.subtitle-overlay-segment')).map((segment) => segment.textContent))
      .toEqual(['First source.第一句。']);
    expect(container.querySelector('.subtitle-overlay-stream-source')?.textContent).toBe('Second source is still live');
    expect(container.querySelector('.subtitle-overlay-stream-text')?.textContent).toBe('第二句仍在输出');

    await updateBurst(
      'First source. Second source is complete. Third source tail',
      '第一句。第二句完成。第三句尾部',
    );

    expect(Array.from(container.querySelectorAll('.subtitle-overlay-segment')).map((segment) => segment.textContent))
      .toEqual(['First source.第一句。', 'Second source is complete.第二句完成。']);
    expect(container.querySelector('.subtitle-overlay-stream-source')?.textContent).toBe('Third source tail');
    expect(container.querySelector('.subtitle-overlay-stream-text')?.textContent).toBe('第三句尾部');
  });

  it('streams the uncommitted ASR tail on the stream source row while the API iterates', async () => {
    const updateIteratingCue = async (sourceText: string) => {
      await act(async () => {
        useAppStore.setState((state) => {
          const nextSnapshot = structuredClone(state.audioRuntimeSnapshot);
          const cue = nextSnapshot.subtitleOverlay.recentCues[0];
          cue.sourceText = sourceText;
          cue.displaySourceText = 'First sentence.';
          cue.translatedText = '第一句。';
          cue.displaySegments = [{ sourceText: 'First sentence.', translatedText: '第一句。', pending: false }];
          cue.committed = false;
          nextSnapshot.subtitleOverlay.activeCue = cue;
          return { ...state, audioRuntimeSnapshot: nextSnapshot };
        });
      });
    };

    await updateIteratingCue('First sentence. still being spoke');
    await view.render(<SubtitleOverlayPage />);
    expect(container.querySelector('.subtitle-overlay-stream-source')?.textContent).toBe('still being spoke');
    expect(container.querySelector('.subtitle-overlay-stream-slot')?.className).toContain('subtitle-overlay-stream-slot-active');

    await updateIteratingCue('First sentence. still being spoken right now');
    expect(container.querySelector('.subtitle-overlay-stream-source')?.textContent).toBe('still being spoken right now');
  });

  it('hides the ASR tail when the displayed segments no longer prefix the raw source', async () => {
    useAppStore.setState((state) => {
      const nextSnapshot = structuredClone(state.audioRuntimeSnapshot);
      const cue = nextSnapshot.subtitleOverlay.recentCues[0];
      cue.sourceText = 'Rewritten raw source after revision';
      cue.displaySourceText = 'First sentence.';
      cue.translatedText = '第一句。';
      cue.displaySegments = [{ sourceText: 'First sentence.', translatedText: '第一句。', pending: false }];
      cue.committed = false;
      nextSnapshot.subtitleOverlay.activeCue = cue;
      return { ...state, audioRuntimeSnapshot: nextSnapshot };
    });

    await view.render(<SubtitleOverlayPage />);

    expect(container.querySelector('.subtitle-overlay-stream-source')?.textContent).toBe('\u00a0');
    expect(container.textContent).not.toContain('Rewritten raw source after revision');
  });

  it('renders translated-only display segments without an empty source paragraph', async () => {
    useAppStore.setState((state) => {
      const nextSnapshot = structuredClone(state.audioRuntimeSnapshot);
      const cue = nextSnapshot.subtitleOverlay.recentCues[0];
      cue.displaySegments = [{ sourceText: '', translatedText: '仅译文', pending: false }];
      cue.displaySourceText = '';
      cue.sourceText = '';
      cue.translatedText = '仅译文';
      nextSnapshot.subtitleOverlay.activeCue = cue;
      return { ...state, audioRuntimeSnapshot: nextSnapshot };
    });

    await view.render(<SubtitleOverlayPage />);
    const segment = container.querySelector('.subtitle-overlay-segment');
    expect(segment?.querySelector('.subtitle-overlay-source')).toBeNull();
    expect(segment?.textContent).toContain('仅译文');
  });

  it('uses the configured subtitle font size as the overlay baseline', async () => {
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...state.configDraft,
        subtitles: {
          ...state.configDraft.subtitles,
          overlayFontSize: 36,
        },
      },
    }));

    await view.render(<SubtitleOverlayPage />);

    const source = container.querySelector<HTMLElement>('.subtitle-overlay-source');
    const translation = container.querySelector<HTMLElement>('.subtitle-overlay-translation');
    expect(source?.style.fontSize).toBe('36px');
    expect(translation?.style.fontSize).toBe('30px');
  });

  it('uses friendly empty placeholder copy with the configured subtitle font size', async () => {
    useAppStore.setState((state) => ({
      ...state,
      audioRuntimeSnapshot: {
        ...state.audioRuntimeSnapshot,
        subtitleOverlay: {
          ...state.audioRuntimeSnapshot.subtitleOverlay,
          activeCue: null,
          queueDepth: 0,
          recentCues: [],
        },
      },
      configDraft: {
        ...state.configDraft,
        subtitles: {
          ...state.configDraft.subtitles,
          overlayFontSize: 36,
        },
      },
    }));

    await view.render(<SubtitleOverlayPage />);

    const source = container.querySelector<HTMLElement>('.subtitle-overlay-source');
    const translation = container.querySelector<HTMLElement>('.subtitle-overlay-translation');
    expect(source?.textContent).toBe('overlay.previewTitleEnglish');
    expect(translation?.textContent).toBe('overlay.previewTitle');
    expect(source?.style.fontSize).toBe('36px');
    expect(translation?.style.fontSize).toBe('30px');
  });

  it('does not render a duplicate source placeholder when both localized lines are identical', async () => {
    await act(async () => {
      view.root.render(<SubtitleOverlayContent
        cardStyle={{}}
        displayCues={[]}
        effectiveFontSize={24}
        lockLabel="lock"
        overlayLocked={false}
        previewSource="字幕已就绪"
        previewTranslation="字幕已就绪"
        showLockToggle={false}
        windowSized
        onLockBlur={() => undefined}
        onLockHover={() => undefined}
        onLockToggle={() => undefined}
      />);
    });

    const source = container.querySelector('.subtitle-overlay-source');
    const translation = container.querySelector('.subtitle-overlay-translation');
    expect(source).toBeNull();
    expect(translation).not.toBeNull();
  });

  it('follows the latest subtitle until the user scrolls up, then resumes at the bottom', async () => {
    const makeCue = (index: number) => ({
      cueId: `history-cue-${index}`,
      routeDirection: 'inbound' as const,
      sourceText: `Source ${index}`,
      translatedText: `Translation ${index}`,
      displaySegments: [{ sourceText: `Source ${index}`, translatedText: `Translation ${index}`, pending: false }],
      startedAt: 'test',
      endedAt: 'test',
      committed: true,
    });
    const renderContent = async (cueCount: number) => {
      await act(async () => {
        view.root.render(<SubtitleOverlayContent
          cardStyle={{}}
          displayCues={Array.from({ length: cueCount }, (_, index) => makeCue(index))}
          effectiveFontSize={24}
          lockLabel="lock"
          overlayLocked={false}
          previewSource="Subtitles ready"
          previewTranslation="字幕已就绪"
          showLockToggle={false}
          windowSized
          onLockBlur={() => undefined}
          onLockHover={() => undefined}
          onLockToggle={() => undefined}
        />);
      });
    };

    await renderContent(3);
    const cues = container.querySelector<HTMLElement>('.subtitle-overlay-history')!;
    Object.defineProperties(cues, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 600 },
    });

    await renderContent(4);
    expect(cues.scrollTop).toBe(600);

    cues.scrollTop = 100;
    cues.dispatchEvent(new Event('scroll', { bubbles: true }));
    await renderContent(5);
    expect(cues.scrollTop).toBe(100);

    cues.scrollTop = 400;
    cues.dispatchEvent(new Event('scroll', { bubbles: true }));
    Object.defineProperty(cues, 'scrollHeight', { configurable: true, value: 700 });
    await renderContent(6);
    expect(cues.scrollTop).toBe(700);
  });

  it('keeps a bottom-pinned subtitle list aligned after its visible height changes', async () => {
    let notifyResize: (() => void) | undefined;
    const OriginalResizeObserver = globalThis.ResizeObserver;
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = () => callback([], this as unknown as ResizeObserver);
      }
      observe() { /* test-controlled */ }
      disconnect() { /* test-controlled */ }
      unobserve() { /* test-controlled */ }
    }
    Object.assign(globalThis, { ResizeObserver: ResizeObserverMock });

    try {
      await act(async () => {
        view.root.render(<SubtitleOverlayContent
          cardStyle={{}}
          displayCues={[structuredClone(audioRuntimeSnapshotMock.subtitleOverlay.recentCues[0])]}
          effectiveFontSize={24}
          lockLabel="lock"
          overlayLocked={false}
          previewSource="Subtitles ready"
          previewTranslation="字幕已就绪"
          showLockToggle={false}
          windowSized
          onLockBlur={() => undefined}
          onLockHover={() => undefined}
          onLockToggle={() => undefined}
        />);
      });
      const cues = container.querySelector<HTMLElement>('.subtitle-overlay-history')!;
      Object.defineProperty(cues, 'scrollHeight', { configurable: true, value: 480 });
      notifyResize?.();
      expect(cues.scrollTop).toBe(480);
    } finally {
      Object.assign(globalThis, { ResizeObserver: OriginalResizeObserver });
    }
  });

  it('does not auto-scroll a user-paused list during resize and renders fallback segment forms', async () => {
    let notifyResize: (() => void) | undefined;
    const OriginalResizeObserver = globalThis.ResizeObserver;
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) { notifyResize = () => callback([], this as unknown as ResizeObserver); }
      observe() { /* test-controlled */ }
      disconnect() { /* test-controlled */ }
      unobserve() { /* test-controlled */ }
    }
    Object.assign(globalThis, { ResizeObserver: ResizeObserverMock });
    try {
      await act(async () => view.root.render(<SubtitleOverlayContent
        cardStyle={{}} effectiveFontSize={24} lockLabel="lock" overlayLocked={false}
        previewSource="source" previewTranslation="translation" showLockToggle windowSized={false}
        onLockBlur={vi.fn()} onLockHover={vi.fn()} onLockToggle={vi.fn()}
        displayCues={[
          { cueId: 'legacy', routeDirection: 'inbound', sourceText: '', translatedText: 'legacy translation', startedAt: 'test', endedAt: 'test', committed: true },
          { cueId: 'pending', routeDirection: 'inbound', sourceText: 'source without translation\nlive source',
            displaySourceText: 'source without translation\nlive source', translatedText: 'live translation', displaySegments: [
            { sourceText: '', translatedText: '', pending: false },
            { sourceText: 'source without translation', translatedText: '', pending: false },
            { sourceText: 'live source', translatedText: '', pending: true },
            { sourceText: '', translatedText: 'live translation', pending: true },
          ], startedAt: 'test', endedAt: 'test', committed: false },
        ]}
      />));
      const history = container.querySelector<HTMLElement>('.subtitle-overlay-history')!;
      Object.defineProperties(history, {
        clientHeight: { configurable: true, value: 100 },
        scrollHeight: { configurable: true, value: 500 },
      });
      history.scrollTop = 100;
      await act(async () => history.dispatchEvent(new Event('scroll', { bubbles: true })));
      notifyResize?.();
      expect(history.scrollTop).toBe(100);
      expect(container.textContent).toContain('live source');
    } finally {
      Object.assign(globalThis, { ResizeObserver: OriginalResizeObserver });
    }
  });

  it('renders at most twelve recent cues and emphasizes the latest regardless of caption density', async () => {
    useAppStore.setState((state) => {
      const recentCues = Array.from({ length: 15 }, (_, index) => ({
        cueId: `dense-cue-${index}`,
        routeDirection: 'inbound' as const,
        sourceText: `Source ${index}`,
        translatedText: `Translation ${index}`,
        displaySegments: [
          {
            sourceText: `Source ${index}`,
            translatedText: `Translation ${index}`,
            pending: false,
          },
        ],
        startedAt: 'test',
        endedAt: 'test',
        committed: true,
      }));

      return {
        ...state,
        audioRuntimeSnapshot: {
          ...state.audioRuntimeSnapshot,
          subtitleOverlay: {
            ...state.audioRuntimeSnapshot.subtitleOverlay,
            activeCue: recentCues[0],
            queueDepth: recentCues.length,
            recentCues,
          },
        },
        configDraft: {
          ...state.configDraft,
          subtitles: {
            ...state.configDraft.subtitles,
            overlayFontSize: 24,
            captionDensity: 'compact',
          },
        },
      };
    });

    await view.render(<SubtitleOverlayPage />);

    const sources = Array.from(container.querySelectorAll<HTMLElement>('.subtitle-overlay-source'));
    const translations = Array.from(container.querySelectorAll<HTMLElement>('.subtitle-overlay-translation'));
    expect(sources).toHaveLength(12);
    expect(sources.map((item) => item.textContent)).toEqual(
      Array.from({ length: 12 }, (_, index) => `Source ${11 - index}`),
    );
    expect(sources[0].style.fontSize).toBe('19px');
    expect(sources[11].style.fontSize).toBe('24px');
    expect(translations[11].style.fontSize).toBe('20px');

    for (const captionDensity of ['balanced', 'detailed'] as const) {
      useAppStore.setState((state) => ({
        ...state,
        configDraft: {
          ...state.configDraft,
          subtitles: { ...state.configDraft.subtitles, captionDensity },
        },
      }));
      await view.render(<SubtitleOverlayPage />);
      expect(container.querySelectorAll('.subtitle-overlay-source')).toHaveLength(12);
    }
  });
});
