import { act, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  setPosition: vi.fn(),
  setSize: vi.fn(),
  outerPosition: vi.fn(),
  outerSize: vi.fn(),
  scaleFactor: vi.fn(),
}));

vi.mock('../../runtime/tauri-runtime', () => ({ isTauriRuntime: () => mocks.isTauri() }));
vi.mock('../../runtime/overlay-window-adapter', () => ({
  LogicalSize: class LogicalSize { constructor(public width: number, public height: number) {} },
  PhysicalPosition: class PhysicalPosition { constructor(public x: number, public y: number) {} },
  getCurrentWindow: () => ({
    setPosition: mocks.setPosition,
    setSize: mocks.setSize,
    outerPosition: mocks.outerPosition,
    outerSize: mocks.outerSize,
    scaleFactor: mocks.scaleFactor,
  }),
}));

import { useOverlayPointerInteractions } from './useOverlayPointerInteractions';
import type { OverlayDragState, OverlayResizeState } from './overlayDomain';

type Controller = ReturnType<typeof useOverlayPointerInteractions>;

describe('useOverlayPointerInteractions imperative IPC cleanup', () => {
  let container: HTMLDivElement;
  let root: Root;
  let controller: Controller;
  const refs = {
    drag: { current: null as OverlayDragState | null },
    resize: { current: null as OverlayResizeState | null },
    dragBusy: { current: false },
    resizeBusy: { current: false },
  };
  const scheduleDrag = vi.fn();
  const scheduleResize = vi.fn();
  const syncPosition = vi.fn().mockResolvedValue(undefined);
  const persistBounds = vi.fn().mockResolvedValue(undefined);

  function Harness() {
    const dragStateRef = useRef(refs.drag.current);
    const resizeStateRef = useRef(refs.resize.current);
    const dragInProgressRef = useRef(refs.dragBusy.current);
    const resizeInProgressRef = useRef(refs.resizeBusy.current);
    refs.drag = dragStateRef;
    refs.resize = resizeStateRef;
    refs.dragBusy = dragInProgressRef;
    refs.resizeBusy = resizeInProgressRef;
    controller = useOverlayPointerInteractions({
      overlayLocked: false,
      dragStateRef,
      resizeStateRef,
      dragInProgressRef,
      resizeInProgressRef,
      scheduleDraggedWindowPosition: scheduleDrag,
      scheduleResizedWindowBounds: scheduleResize,
      syncOverlayDraftPosition: syncPosition,
      persistOverlayBounds: persistBounds,
    });
    return null;
  }

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.isTauri.mockReturnValue(true);
    mocks.setPosition.mockResolvedValue(undefined);
    mocks.setSize.mockResolvedValue(undefined);
    mocks.outerPosition.mockResolvedValue({ x: 100, y: 200 });
    mocks.outerSize.mockResolvedValue({ width: 400, height: 160 });
    mocks.scaleFactor.mockResolvedValue(2);
    scheduleDrag.mockReset();
    scheduleResize.mockReset();
    syncPosition.mockReset().mockResolvedValue(undefined);
    persistBounds.mockReset().mockResolvedValue(undefined);
    refs.drag = { current: null };
    refs.resize = { current: null };
    refs.dragBusy = { current: false };
    refs.resizeBusy = { current: false };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function pointerEvent(pointerId: number, overrides: Record<string, unknown> = {}) {
    const target = document.createElement('div');
    return {
      pointerId,
      button: 0,
      screenX: 20,
      screenY: 30,
      target,
      currentTarget: target,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      ...overrides,
    } as unknown as ReactPointerEvent<HTMLDivElement>;
  }

  it('cancels pending drag and resize animation frames on unmount', async () => {
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    refs.drag.current = { pointerId: 1, frameId: 7 } as OverlayDragState;
    refs.resize.current = { pointerId: 2, frameId: 9 } as OverlayResizeState;

    await act(async () => root.unmount());

    expect(cancel.mock.calls.map(([id]) => id)).toEqual([7, 9]);
    root = createRoot(container);
  });

  it('finishes captured drag and resize sessions and cancels their queued frames', async () => {
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const releasePointerCapture = vi.fn();
    const dragTarget = Object.assign(document.createElement('div'), {
      hasPointerCapture: () => true,
      releasePointerCapture,
    });
    refs.drag.current = {
      pointerId: 3, frameId: 11, scaleFactor: 1,
      startScreenX: 0, startScreenY: 0, startWindowX: 0, startWindowY: 0,
      targetX: 320, targetY: 240,
    };

    await controller.finishOverlayDrag(pointerEvent(3, { currentTarget: dragTarget }));

    expect(releasePointerCapture).toHaveBeenCalledWith(3);
    expect(cancel).toHaveBeenCalledWith(11);
    expect(syncPosition).toHaveBeenCalledWith(expect.objectContaining({ x: 320, y: 240 }));

    const resizeTarget = Object.assign(document.createElement('div'), {
      hasPointerCapture: () => true,
      releasePointerCapture,
    });
    refs.resize.current = {
      direction: 'SouthEast', pointerId: 4, frameId: 12, scaleFactor: 2,
      startScreenX: 0, startScreenY: 0, startWindowX: 0, startWindowY: 0,
      startWindowWidth: 400, startWindowHeight: 160,
      targetX: 10, targetY: 20, targetWidth: 800, targetHeight: 320,
    };

    await controller.finishOverlayResize(pointerEvent(4, { currentTarget: resizeTarget }));

    expect(cancel).toHaveBeenCalledWith(12);
    expect(mocks.setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 400, height: 160 }));
    expect(persistBounds).toHaveBeenCalledWith(expect.objectContaining({ x: 10, y: 20 }), 400, 160);
  });

  it('does not start a window drag from the lock button', async () => {
    const lockButton = document.createElement('button');
    lockButton.className = 'subtitle-overlay-toggle-lock';
    await controller.handleOverlayPointerDown(pointerEvent(5, { target: lockButton }));
    expect(mocks.outerPosition).not.toHaveBeenCalled();
  });

  it('covers uncaptured, unqueued completion and rejected resize starts', async () => {
    const target = Object.assign(document.createElement('div'), {
      hasPointerCapture: () => false,
      releasePointerCapture: vi.fn(),
    });
    refs.drag.current = {
      pointerId: 6, frameId: null, scaleFactor: 1,
      startScreenX: 0, startScreenY: 0, startWindowX: 0, startWindowY: 0,
      targetX: 1, targetY: 2,
    };
    await controller.finishOverlayDrag(pointerEvent(6, { currentTarget: target }));
    expect(target.releasePointerCapture).not.toHaveBeenCalled();

    mocks.isTauri.mockReturnValue(false);
    await controller.handleResizePointerDown('SouthEast', pointerEvent(7));
    expect(mocks.outerSize).not.toHaveBeenCalled();
    mocks.isTauri.mockReturnValue(true);

    refs.resize.current = {
      direction: 'SouthEast', pointerId: 8, frameId: null, scaleFactor: 1,
      startScreenX: 0, startScreenY: 0, startWindowX: 0, startWindowY: 0,
      startWindowWidth: 400, startWindowHeight: 160,
      targetX: 0, targetY: 0, targetWidth: 400, targetHeight: 160,
    };
    await controller.finishOverlayResize(pointerEvent(8, { currentTarget: target }));
    expect(target.releasePointerCapture).not.toHaveBeenCalled();
  });
});
