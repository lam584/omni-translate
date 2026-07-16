import { useEffect, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { LogicalSize, PhysicalPosition, getCurrentWindow } from '../../runtime/overlay-window-adapter';
import { isTauriRuntime } from '../../runtime/tauri-runtime';
import {
  calculateOverlayResizeBounds,
  MAX_OVERLAY_HEIGHT,
  MAX_OVERLAY_WIDTH,
  MIN_OVERLAY_HEIGHT,
  MIN_OVERLAY_WIDTH,
  type OverlayDragState,
  type OverlayResizeDirection,
  type OverlayResizeState,
} from './overlayDomain';

type Params = {
  overlayLocked: boolean;
  dragStateRef: MutableRefObject<OverlayDragState | null>;
  resizeStateRef: MutableRefObject<OverlayResizeState | null>;
  dragInProgressRef: MutableRefObject<boolean>;
  resizeInProgressRef: MutableRefObject<boolean>;
  scheduleDraggedWindowPosition: () => void;
  scheduleResizedWindowBounds: () => void;
  syncOverlayDraftPosition: (position: { x: number; y: number }) => Promise<void>;
  persistOverlayBounds: (position: { x: number; y: number }, width: number, height: number) => Promise<void>;
};

export function useOverlayPointerInteractions(params: Params) {
  const { dragStateRef, resizeStateRef } = params;
  useEffect(() => () => {
    const drag = dragStateRef.current;
    if (drag?.frameId != null) window.cancelAnimationFrame(drag.frameId);
    const resize = resizeStateRef.current;
    if (resize?.frameId != null) window.cancelAnimationFrame(resize.frameId);
  }, [dragStateRef, resizeStateRef]);

  const finishOverlayDrag = async (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = params.dragStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (state.frameId !== null) window.cancelAnimationFrame(state.frameId);
    // eslint-disable-next-line react-hooks/immutability -- interaction refs are the imperative pointer-session state.
    params.dragStateRef.current = null;
    params.dragInProgressRef.current = false;
    const position = new PhysicalPosition(state.targetX, state.targetY);
    await getCurrentWindow().setPosition(position);
    await params.syncOverlayDraftPosition(position);
  };

  const handleOverlayPointerDown = async (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isTauriRuntime() || params.overlayLocked || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('.subtitle-overlay-toggle-lock')) return;
    const targetElement = event.currentTarget;
    event.preventDefault();
    event.stopPropagation();
    const windowHandle = getCurrentWindow();
    const [position, scaleFactor] = await Promise.all([windowHandle.outerPosition(), windowHandle.scaleFactor()]);
    // eslint-disable-next-line react-hooks/immutability -- pointer-down initializes the shared drag session.
    params.dragStateRef.current = {
      pointerId: event.pointerId,
      frameId: null,
      scaleFactor,
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      startWindowX: position.x,
      startWindowY: position.y,
      targetX: position.x,
      targetY: position.y,
    };
    params.dragInProgressRef.current = true;
    targetElement.setPointerCapture(event.pointerId);
  };

  const handleOverlayPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = params.dragStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    /* eslint-disable react-hooks/immutability -- pointer movement updates the current imperative frame target. */
    state.targetX = state.startWindowX + Math.round((event.screenX - state.startScreenX) * state.scaleFactor);
    state.targetY = state.startWindowY + Math.round((event.screenY - state.startScreenY) * state.scaleFactor);
    /* eslint-enable react-hooks/immutability */
    params.scheduleDraggedWindowPosition();
  };

  const handleResizePointerDown = async (direction: OverlayResizeDirection, event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isTauriRuntime() || params.overlayLocked || event.button !== 0) return;
    const targetElement = event.currentTarget;
    event.preventDefault();
    event.stopPropagation();
    const windowHandle = getCurrentWindow();
    const [position, size, scaleFactor] = await Promise.all([
      windowHandle.outerPosition(),
      windowHandle.outerSize(),
      windowHandle.scaleFactor(),
    ]);
    // eslint-disable-next-line react-hooks/immutability -- pointer-down initializes the shared resize session.
    params.resizeStateRef.current = {
      direction,
      frameId: null,
      pointerId: event.pointerId,
      scaleFactor,
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      startWindowHeight: size.height,
      startWindowWidth: size.width,
      startWindowX: position.x,
      startWindowY: position.y,
      targetHeight: size.height,
      targetWidth: size.width,
      targetX: position.x,
      targetY: position.y,
    };
    params.resizeInProgressRef.current = true;
    targetElement.setPointerCapture(event.pointerId);
  };

  const handleResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = params.resizeStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = calculateOverlayResizeBounds(state, event.screenX, event.screenY);
    Object.assign(state, { targetWidth: bounds.width, targetHeight: bounds.height, targetX: bounds.x, targetY: bounds.y });
    params.scheduleResizedWindowBounds();
  };

  const finishOverlayResize = async (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = params.resizeStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (state.frameId !== null) window.cancelAnimationFrame(state.frameId);
    const position = new PhysicalPosition(state.targetX, state.targetY);
    const width = Math.min(MAX_OVERLAY_WIDTH, Math.max(MIN_OVERLAY_WIDTH, Math.round(state.targetWidth / state.scaleFactor)));
    const height = Math.min(MAX_OVERLAY_HEIGHT, Math.max(MIN_OVERLAY_HEIGHT, Math.round(state.targetHeight / state.scaleFactor)));
    await getCurrentWindow().setPosition(position);
    await getCurrentWindow().setSize(new LogicalSize(width, height));
    await params.persistOverlayBounds(position, width, height);
    // eslint-disable-next-line react-hooks/immutability -- finishing clears the shared resize session.
    params.resizeStateRef.current = null;
    params.resizeInProgressRef.current = false;
  };

  return { finishOverlayDrag, handleOverlayPointerDown, handleOverlayPointerMove, handleResizePointerDown, handleResizePointerMove, finishOverlayResize };
}
