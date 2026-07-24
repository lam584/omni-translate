import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
  syncRegion: vi.fn(),
  currentMonitor: vi.fn(),
  outerSize: vi.fn(),
  outerPosition: vi.fn(),
  setPosition: vi.fn(),
  setLogicalSize: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock('../../runtime/tauri-runtime', () => ({
  isTauriRuntime: () => mocks.isTauri(),
}));

vi.mock('../../runtime/desktop-api-context', () => ({
  useDesktopApiV2: () => ({
    session: { syncOverlayRegion: mocks.syncRegion },
    window: {
      currentMonitor: mocks.currentMonitor,
      outerSize: mocks.outerSize,
      outerPosition: mocks.outerPosition,
      setPosition: mocks.setPosition,
      setLogicalSize: mocks.setLogicalSize,
    },
  }),
}));

import { useOverlayWindowController } from './useOverlayWindowController';

type Controller = ReturnType<typeof useOverlayWindowController>;

describe('useOverlayWindowController native IPC coordination', () => {
  let container: HTMLDivElement;
  let root: Root;
  let controller: Controller;
  const updatePosition = vi.fn();
  const updateSize = vi.fn();
  const refs = {
    overlayPosition: { current: { x: 10, y: 20 } },
    drag: { current: null as null | { frameId: number | null; targetX: number; targetY: number } },
    resize: { current: null as null | { frameId: number | null; targetX: number; targetY: number; targetWidth: number; targetHeight: number; scaleFactor: number } },
    size: { current: null as null | { width: number; height: number } },
  };

  function Harness() {
    const overlayPositionRef = useRef(refs.overlayPosition.current);
    const dragStateRef = useRef(refs.drag.current);
    const resizeStateRef = useRef(refs.resize.current);
    const lastAppliedWindowSizeRef = useRef(refs.size.current);
    refs.overlayPosition = overlayPositionRef;
    refs.drag = dragStateRef;
    refs.resize = resizeStateRef;
    refs.size = lastAppliedWindowSizeRef;
    controller = useOverlayWindowController({
      overlayLocked: true,
      overlayPositionRef,
      toAxisPercent: (position, start, distance) => (position - start) / distance,
      updatePosition,
      dragStateRef,
      resizeStateRef,
      lastAppliedWindowSizeRef,
      updateSize,
    });
    return null;
  }

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    for (const mock of Object.values(mocks)) mock.mockReset();
    updatePosition.mockReset();
    updateSize.mockReset();
    mocks.isTauri.mockReturnValue(true);
    mocks.syncRegion.mockResolvedValue(undefined);
    mocks.invoke.mockResolvedValue(undefined);
    mocks.currentMonitor.mockResolvedValue({ workArea: { position: { x: 100, y: 200 }, size: { width: 1000, height: 800 } } });
    mocks.outerSize.mockResolvedValue({ width: 400, height: 200 });
    mocks.outerPosition.mockResolvedValue({ x: 400, y: 500 });
    mocks.setPosition.mockResolvedValue(undefined);
    mocks.setLogicalSize.mockResolvedValue(undefined);
    refs.overlayPosition = { current: { x: 10, y: 20 } };
    refs.drag = { current: null };
    refs.resize = { current: null };
    refs.size = { current: null };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await act(async () => root.unmount());
    container.remove();
  });

  it('skips native synchronization outside Tauri', async () => {
    mocks.isTauri.mockReturnValue(false);

    await controller.syncNativeOverlayRegion();
    await controller.syncNativeOverlayWindowState();
    await controller.syncOverlayDraftPosition();

    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.currentMonitor).not.toHaveBeenCalled();
  });

  it('sends region, lock state, and monitor-derived draft position through IPC', async () => {
    await controller.syncNativeOverlayRegion(false);
    await controller.syncNativeOverlayWindowState();
    await controller.syncNativeOverlayWindowState(false, true, true);
    await controller.syncOverlayDraftPosition();

    expect(mocks.syncRegion).toHaveBeenCalledWith(false);
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'sync_subtitle_overlay_window_state', {
      locked: true, rounded: true, hotspotInteractive: false,
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'sync_subtitle_overlay_window_state', {
      locked: false, rounded: true, hotspotInteractive: true,
    });
    expect(updatePosition).toHaveBeenCalledWith({ x: 0.5, y: 0.5 });

    updatePosition.mockClear();
    await controller.syncOverlayDraftPosition({ x: 400, y: 500 });
    expect(updatePosition).not.toHaveBeenCalled();

    mocks.currentMonitor.mockResolvedValueOnce(null);
    await controller.syncOverlayDraftPosition({ x: 0, y: 0 });
    expect(updatePosition).not.toHaveBeenCalled();
  });

  it('flushes and schedules dragged and resized native window bounds', async () => {
    await controller.flushDraggedWindowPosition();
    await controller.flushResizedWindowBounds();
    expect(mocks.setPosition).not.toHaveBeenCalled();

    refs.drag.current = { frameId: null, targetX: 320, targetY: 240 };
    refs.resize.current = { frameId: null, targetX: 120, targetY: 80, targetWidth: 900, targetHeight: 450, scaleFactor: 1.5 };
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });

    controller.scheduleDraggedWindowPosition();
    controller.scheduleDraggedWindowPosition();
    controller.scheduleResizedWindowBounds();
    controller.scheduleResizedWindowBounds();
    expect(frames).toHaveLength(2);
    await act(async () => {
      frames.forEach((callback) => callback(0));
      await Promise.resolve();
    });

    expect(mocks.setPosition).toHaveBeenCalledWith({ x: 320, y: 240 });
    expect(mocks.setPosition).toHaveBeenCalledWith({ x: 120, y: 80 });
    expect(mocks.setLogicalSize).toHaveBeenCalledWith({ width: 600, height: 300 });
  });

  it('persists native region, current position, and logical draft size together', async () => {
    await controller.persistOverlayBounds({ x: 700, y: 650 }, 800, 180);

    expect(mocks.syncRegion).toHaveBeenCalledWith(true);
    expect(refs.size.current).toEqual({ width: 800, height: 180 });
    expect(updatePosition).toHaveBeenCalled();
    expect(updateSize).toHaveBeenCalledWith({ overlayWidth: 800, overlayHeight: 180 });
  });
});
