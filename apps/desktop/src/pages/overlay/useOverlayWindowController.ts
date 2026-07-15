import { useCallback, type MutableRefObject } from 'react';

import { useDesktopApiV2 } from '../../runtime/desktop-api-context';
import { isTauriRuntime } from '../../runtime/tauri-runtime';

type OverlayPosition = { x: number; y: number };

type DragFrameState = {
  frameId: number | null;
  targetX: number;
  targetY: number;
};

type ResizeFrameState = DragFrameState & {
  scaleFactor: number;
  targetHeight: number;
  targetWidth: number;
};

type OverlayWindowControllerOptions = {
  overlayLocked: boolean;
  overlayPositionRef: React.MutableRefObject<OverlayPosition>;
  toAxisPercent: (position: number, workAreaStart: number, availableDistance: number) => number;
  updatePosition: (position: OverlayPosition) => void;
  dragStateRef: MutableRefObject<DragFrameState | null>;
  resizeStateRef: MutableRefObject<ResizeFrameState | null>;
  lastAppliedWindowSizeRef: MutableRefObject<{ width: number; height: number } | null>;
  updateSize: (size: { overlayHeight: number; overlayWidth: number }) => void;
};

/** Coordinates desktop-window state with the persisted overlay draft. */
export function useOverlayWindowController({
  overlayLocked,
  overlayPositionRef,
  toAxisPercent,
  updatePosition,
  dragStateRef,
  resizeStateRef,
  lastAppliedWindowSizeRef,
  updateSize,
}: OverlayWindowControllerOptions) {
  const desktopApi = useDesktopApiV2();
  const syncNativeOverlayRegion = useCallback(async (rounded = true) => {
    if (isTauriRuntime()) {
      await desktopApi.session.syncOverlayRegion(rounded);
    }
  }, [desktopApi]);

  const syncNativeOverlayWindowState = useCallback(async (
    locked = overlayLocked,
    rounded = locked,
    hotspotInteractive = false,
  ) => {
    if (isTauriRuntime()) {
      await desktopApi.session.syncOverlayWindowState(locked, rounded, hotspotInteractive);
    }
  }, [desktopApi, overlayLocked]);

  const syncOverlayDraftPosition = useCallback(async (position?: OverlayPosition) => {
    if (!isTauriRuntime()) {
      return;
    }

    const [monitor, windowSize, nextPosition] = await Promise.all([
      desktopApi.window.currentMonitor(),
      desktopApi.window.outerSize(),
      position ? Promise.resolve(position) : desktopApi.window.outerPosition(),
    ]);
    if (!monitor) {
      return;
    }

    const availableWidth = Math.max(1, monitor.workArea.size.width - windowSize.width);
    const availableHeight = Math.max(1, monitor.workArea.size.height - windowSize.height);
    const next = {
      x: toAxisPercent(nextPosition.x, monitor.workArea.position.x, availableWidth),
      y: toAxisPercent(nextPosition.y, monitor.workArea.position.y, availableHeight),
    };
    if (overlayPositionRef.current.x !== next.x || overlayPositionRef.current.y !== next.y) {
      overlayPositionRef.current = next;
      updatePosition(next);
    }
  }, [desktopApi, overlayPositionRef, toAxisPercent, updatePosition]);

  const flushDraggedWindowPosition = async () => {
    const state = dragStateRef.current;
    if (!state) return;
    state.frameId = null;
    await desktopApi.window.setPosition({ x: state.targetX, y: state.targetY });
  };

  const scheduleDraggedWindowPosition = () => {
    const state = dragStateRef.current;
    if (!state || state.frameId !== null) return;
    state.frameId = window.requestAnimationFrame(() => void flushDraggedWindowPosition());
  };

  const flushResizedWindowBounds = async () => {
    const state = resizeStateRef.current;
    if (!state) return;
    state.frameId = null;
    await desktopApi.window.setPosition({ x: state.targetX, y: state.targetY });
    await desktopApi.window.setLogicalSize({
      width: Math.round(state.targetWidth / state.scaleFactor),
      height: Math.round(state.targetHeight / state.scaleFactor),
    });
  };

  const scheduleResizedWindowBounds = () => {
    const state = resizeStateRef.current;
    if (!state || state.frameId !== null) return;
    state.frameId = window.requestAnimationFrame(() => void flushResizedWindowBounds());
  };

  const persistOverlayBounds = async (position: OverlayPosition, width: number, height: number) => {
    await syncNativeOverlayRegion();
    lastAppliedWindowSizeRef.current = { width, height };
    await syncOverlayDraftPosition(position);
    updateSize({ overlayHeight: height, overlayWidth: width });
  };

  return {
    syncNativeOverlayRegion,
    syncNativeOverlayWindowState,
    syncOverlayDraftPosition,
    flushDraggedWindowPosition,
    scheduleDraggedWindowPosition,
    flushResizedWindowBounds,
    scheduleResizedWindowBounds,
    persistOverlayBounds,
  };
}
