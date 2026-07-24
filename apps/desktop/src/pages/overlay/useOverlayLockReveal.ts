import { useEffect, useState } from 'react';
import { cursorPosition, getCurrentWindow } from '../../runtime/overlay-window-adapter';
import { isTauriRuntime } from '../../runtime/tauri-runtime';
import {
  calculateLockedRevealState,
  LOCK_BUTTON_POLL_INTERVAL_MS,
  type LockedRevealState,
} from './overlayDomain';

const HIDDEN_REVEAL: LockedRevealState = { interactive: false, visible: false };

export function useOverlayLockReveal(overlayLocked: boolean) {
  const [lockedReveal, setLockedReveal] = useState<LockedRevealState>(HIDDEN_REVEAL);

  useEffect(() => {
    if (!overlayLocked) {
      queueMicrotask(() => setLockedReveal((current) => (
        current.visible || current.interactive ? HIDDEN_REVEAL : current
      )));
      return undefined;
    }

    if (!isTauriRuntime()) {
      return undefined;
    }

    let disposed = false;
    let inFlight = false;
    const windowHandle = getCurrentWindow();

    const syncRevealState = async () => {
      if (disposed || inFlight) return;
      inFlight = true;

      try {
        const [pointer, overlayPosition, overlaySize, scaleFactor] = await Promise.all([
          cursorPosition(),
          windowHandle.outerPosition(),
          windowHandle.outerSize(),
          windowHandle.scaleFactor(),
        ]);
        if (disposed) return;

        const nextReveal = calculateLockedRevealState(pointer, overlayPosition, overlaySize, scaleFactor);
        setLockedReveal((current) => (
          current.visible === nextReveal.visible && current.interactive === nextReveal.interactive
            ? current
            : nextReveal
        ));
      } catch {
        if (!disposed) {
          setLockedReveal((current) => (
            current.visible || current.interactive ? HIDDEN_REVEAL : current
          ));
        }
      } finally {
        inFlight = false;
      }
    };

    void syncRevealState();
    const intervalId = window.setInterval(() => void syncRevealState(), LOCK_BUTTON_POLL_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [overlayLocked]);

  return { lockedReveal, setLockedReveal };
}
