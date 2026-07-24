import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  onResized: vi.fn(),
  scaleFactor: vi.fn(),
  innerSize: vi.fn(),
  currentMonitor: vi.fn(),
}));

vi.mock('../../runtime/tauri-runtime', () => ({ isTauriRuntime: () => mocks.isTauri() }));
vi.mock('../../runtime/overlay-window-adapter', () => ({
  currentMonitor: () => mocks.currentMonitor(),
  getCurrentWindow: () => ({
    onResized: mocks.onResized,
    scaleFactor: mocks.scaleFactor,
    innerSize: mocks.innerSize,
  }),
}));

import { useOverlayNativeEventSync } from './useOverlayNativeEventSync';

describe('useOverlayNativeEventSync', () => {
  let container: HTMLDivElement;
  let root: Root;
  let resizeCallback: () => Promise<void>;
  const setContextMenu = vi.fn();
  const setHovered = vi.fn();
  const syncRegion = vi.fn().mockResolvedValue(undefined);
  const syncWindowState = vi.fn().mockResolvedValue(undefined);
  const syncPosition = vi.fn().mockResolvedValue(undefined);
  const updateDraft = vi.fn();
  const refs = {
    programmatic: { current: false },
    timer: { current: null as ReturnType<typeof setTimeout> | null },
    resizing: { current: false },
  };

  function Harness({ locked = true, hotspot = false }: { locked?: boolean; hotspot?: boolean }) {
    const programmaticResizeRef = useRef(refs.programmatic.current);
    const resizeDebounceTimerRef = useRef(refs.timer.current);
    const resizeInProgressRef = useRef(refs.resizing.current);
    refs.programmatic = programmaticResizeRef;
    refs.timer = resizeDebounceTimerRef;
    refs.resizing = resizeInProgressRef;
    useOverlayNativeEventSync({
      lockedRevealInteractive: hotspot,
      overlayLocked: locked,
      programmaticResizeRef,
      resizeDebounceTimerRef,
      resizeInProgressRef,
      setContextMenu,
      setHovered,
      syncNativeOverlayRegion: syncRegion,
      syncNativeOverlayWindowState: syncWindowState,
      syncOverlayDraftPosition: syncPosition,
      updateSubtitleDraft: updateDraft,
    });
    return null;
  }

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    for (const mock of Object.values(mocks)) mock.mockReset();
    for (const mock of [setContextMenu, setHovered, syncRegion, syncWindowState, syncPosition, updateDraft]) mock.mockReset();
    mocks.isTauri.mockReturnValue(true);
    mocks.scaleFactor.mockResolvedValue(2);
    mocks.innerSize.mockResolvedValue({ width: 3_000, height: 80 });
    mocks.currentMonitor.mockResolvedValue({ workArea: {} });
    mocks.onResized.mockImplementation(async (callback: () => Promise<void>) => {
      resizeCallback = callback;
      return vi.fn();
    });
    refs.programmatic = { current: false };
    refs.timer = { current: null };
    refs.resizing = { current: false };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('skips subscriptions outside Tauri and syncs unlocked Tauri state without closing UI', async () => {
    mocks.isTauri.mockReturnValue(false);
    await act(async () => root.render(<Harness locked={false} />));
    expect(mocks.onResized).not.toHaveBeenCalled();

    mocks.isTauri.mockReturnValue(true);
    await act(async () => root.render(<Harness locked={false} hotspot />));
    expect(syncWindowState).toHaveBeenCalledWith(false, true, true);
    expect(setHovered).not.toHaveBeenCalled();
  });

  it('closes hover/menu state when locked and handles resize guards and persisted geometry', async () => {
    setContextMenu.mockImplementation((update) => {
      expect(update({ open: false, x: 0, y: 0 })).toEqual({ open: false, x: 0, y: 0 });
      expect(update({ open: true, x: 2, y: 3 })).toEqual({ open: false, x: 2, y: 3 });
    });
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    expect(setHovered).toHaveBeenCalledWith(false);

    refs.resizing.current = true;
    await resizeCallback();
    expect(syncRegion).toHaveBeenCalled();

    refs.resizing.current = false;
    refs.programmatic.current = true;
    await resizeCallback();
    expect(refs.programmatic.current).toBe(false);

    await resizeCallback();
    await resizeCallback();
    await vi.advanceTimersByTimeAsync(300);
    expect(updateDraft).toHaveBeenCalledWith({ overlayWidth: 1280, overlayHeight: 72 });
    expect(syncPosition).toHaveBeenCalled();
  });

  it('skips draft persistence when no current monitor exists', async () => {
    mocks.currentMonitor.mockResolvedValue(null);
    await act(async () => root.render(<Harness locked={false} />));

    await resizeCallback();
    await vi.advanceTimersByTimeAsync(300);

    expect(updateDraft).not.toHaveBeenCalled();
  });

  it('ignores resize callbacks and disposes a listener that resolves after unmount', async () => {
    let resolveListener!: (unlisten: () => void) => void;
    const unlisten = vi.fn();
    mocks.onResized.mockImplementation((callback: () => Promise<void>) => {
      resizeCallback = callback;
      return new Promise((resolve) => { resolveListener = resolve; });
    });
    await act(async () => root.render(<Harness />));
    await act(async () => root.unmount());

    await resizeCallback();
    resolveListener(unlisten);
    await Promise.resolve();

    expect(syncRegion).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalled();
    root = createRoot(container);
  });
});
