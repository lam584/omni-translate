import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';

import { currentMonitor, getCurrentWindow } from '../../runtime/overlay-window-adapter';
import { isTauriRuntime } from '../../runtime/tauri-runtime';
import type { SubtitleDraft } from '../../schema/config';
import { OVERLAY_RESIZE_DEBOUNCE_MS, type OverlayContextMenuState } from './overlayDomain';

type Options = {
  lockedRevealInteractive: boolean;
  overlayLocked: boolean;
  programmaticResizeRef: MutableRefObject<boolean>;
  resizeDebounceTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  resizeInProgressRef: MutableRefObject<boolean>;
  setContextMenu: Dispatch<SetStateAction<OverlayContextMenuState>>;
  setHovered: Dispatch<SetStateAction<boolean>>;
  syncNativeOverlayRegion: () => Promise<void>;
  syncNativeOverlayWindowState: (locked: boolean, rounded: boolean, hotspotInteractive: boolean) => Promise<void>;
  syncOverlayDraftPosition: () => Promise<void>;
  updateSubtitleDraft: (patch: Partial<SubtitleDraft>) => void;
};

export function useOverlayNativeEventSync(options: Options) {
  const { lockedRevealInteractive, overlayLocked, programmaticResizeRef, resizeDebounceTimerRef,
    resizeInProgressRef, setContextMenu, setHovered, syncNativeOverlayRegion,
    syncNativeOverlayWindowState, syncOverlayDraftPosition, updateSubtitleDraft } = options;

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    if (overlayLocked) queueMicrotask(() => {
      setHovered(false);
      setContextMenu((current) => current.open ? { ...current, open: false } : current);
    });
    void syncNativeOverlayWindowState(overlayLocked, true, lockedRevealInteractive);
    return undefined;
  }, [lockedRevealInteractive, overlayLocked, setContextMenu, setHovered, syncNativeOverlayWindowState]);

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const windowHandle = getCurrentWindow();
    void windowHandle.onResized(async () => {
      if (disposed) return;
      await syncNativeOverlayRegion();
      if (resizeInProgressRef.current) return;
      if (programmaticResizeRef.current) { programmaticResizeRef.current = false; return; }
      if (resizeDebounceTimerRef.current !== null) clearTimeout(resizeDebounceTimerRef.current);
      resizeDebounceTimerRef.current = setTimeout(async () => {
        resizeDebounceTimerRef.current = null;
        const scaleFactor = await windowHandle.scaleFactor();
        const windowSize = await windowHandle.innerSize();
        if (!await currentMonitor()) return;
        updateSubtitleDraft({
          overlayHeight: Math.max(72, Math.round(windowSize.height / scaleFactor)),
          overlayWidth: Math.max(220, Math.round(windowSize.width / scaleFactor)),
        });
        await syncOverlayDraftPosition();
      }, OVERLAY_RESIZE_DEBOUNCE_MS);
    }).then((nextUnlisten) => disposed ? nextUnlisten() : (unlisten = nextUnlisten));
    return () => {
      disposed = true;
      if (resizeDebounceTimerRef.current !== null) {
        clearTimeout(resizeDebounceTimerRef.current);
        resizeDebounceTimerRef.current = null;
      }
      unlisten?.();
    };
  }, [programmaticResizeRef, resizeDebounceTimerRef, resizeInProgressRef, syncNativeOverlayRegion, syncOverlayDraftPosition, updateSubtitleDraft]);
}
