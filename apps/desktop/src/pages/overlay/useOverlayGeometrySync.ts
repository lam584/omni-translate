import { useEffect, type MutableRefObject } from 'react';

import { currentMonitor, getCurrentWindow, LogicalSize, PhysicalPosition } from '../../runtime/overlay-window-adapter';
import { isTauriRuntime } from '../../runtime/tauri-runtime';
import { clamp, MAX_OVERLAY_HEIGHT, MAX_OVERLAY_WIDTH, MIN_OVERLAY_HEIGHT, MIN_OVERLAY_WIDTH, toOverlayAxisPercent } from './overlayDomain';

type Options = {
  dragInProgressRef: MutableRefObject<boolean>;
  lastAppliedWindowSizeRef: MutableRefObject<{ width: number; height: number } | null>;
  overlayHeight: number;
  overlayWidth: number;
  overlayX: number;
  overlayY: number;
  programmaticResizeRef: MutableRefObject<boolean>;
  syncNativeOverlayRegion: () => Promise<void>;
};

export function useOverlayGeometrySync(options: Options) {
  const { dragInProgressRef, lastAppliedWindowSizeRef, overlayHeight, overlayWidth, overlayX, overlayY,
    programmaticResizeRef, syncNativeOverlayRegion } = options;

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    let disposed = false;
    const applyWindowGeometry = async () => {
      const windowHandle = getCurrentWindow();
      const logicalWidth = clamp(Math.round(overlayWidth), MIN_OVERLAY_WIDTH, MAX_OVERLAY_WIDTH);
      const logicalHeight = clamp(Math.round(overlayHeight), MIN_OVERLAY_HEIGHT, MAX_OVERLAY_HEIGHT);
      const lastSize = lastAppliedWindowSizeRef.current;
      if (!lastSize || lastSize.width !== logicalWidth || lastSize.height !== logicalHeight) {
        lastAppliedWindowSizeRef.current = { width: logicalWidth, height: logicalHeight };
        programmaticResizeRef.current = true;
        await windowHandle.setSize(new LogicalSize(logicalWidth, logicalHeight));
      }
      await syncNativeOverlayRegion();
      const monitor = await currentMonitor();
      if (!monitor || disposed) return;
      const windowSize = await windowHandle.outerSize();
      const availableWidth = Math.max(0, monitor.workArea.size.width - windowSize.width);
      const availableHeight = Math.max(0, monitor.workArea.size.height - windowSize.height);
      await windowHandle.setPosition(new PhysicalPosition(
        monitor.workArea.position.x + Math.round((availableWidth * clamp(overlayX, 0, 100)) / 100),
        monitor.workArea.position.y + Math.round((availableHeight * clamp(overlayY, 0, 100)) / 100),
      ));
    };
    void applyWindowGeometry();
    return () => { disposed = true; };
  }, [lastAppliedWindowSizeRef, overlayHeight, overlayWidth, overlayX, overlayY, programmaticResizeRef, syncNativeOverlayRegion]);

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const appRoot = document.getElementById('root');
    const previous = [root.getAttribute('style'), body.getAttribute('style'), appRoot?.getAttribute('style') ?? null];
    root.style.background = 'transparent'; root.style.overflow = 'hidden';
    body.style.background = 'transparent'; body.style.overflow = 'hidden'; body.style.margin = '0';
    if (appRoot) { appRoot.style.background = 'transparent'; appRoot.style.minHeight = '0'; appRoot.style.width = 'fit-content'; }
    let disposed = false;
    if (isTauriRuntime()) {
      const applyPosition = async () => {
        if (dragInProgressRef.current) return;
        const monitor = await currentMonitor();
        if (!monitor || disposed) return;
        const windowHandle = getCurrentWindow();
        const [windowSize, position] = await Promise.all([windowHandle.outerSize(), windowHandle.outerPosition()]);
        const availableWidth = Math.max(0, monitor.workArea.size.width - windowSize.width);
        const availableHeight = Math.max(0, monitor.workArea.size.height - windowSize.height);
        const requestedX = clamp(overlayX, 0, 100); const requestedY = clamp(overlayY, 0, 100);
        if (toOverlayAxisPercent(position.x, monitor.workArea.position.x, availableWidth) === requestedX
          && toOverlayAxisPercent(position.y, monitor.workArea.position.y, availableHeight) === requestedY) return;
        await windowHandle.setPosition(new PhysicalPosition(
          monitor.workArea.position.x + Math.round((availableWidth * requestedX) / 100),
          monitor.workArea.position.y + Math.round((availableHeight * requestedY) / 100),
        ));
      };
      void applyPosition();
    }
    return () => {
      disposed = true;
      const restore = (element: HTMLElement, value: string | null) => value === null ? element.removeAttribute('style') : element.setAttribute('style', value);
      restore(root, previous[0]); restore(body, previous[1]); if (appRoot) restore(appRoot, previous[2]);
    };
  }, [dragInProgressRef, overlayX, overlayY]);
}
