import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';
import { Menu } from '@tauri-apps/api/menu';
import { currentMonitor, cursorPosition, getCurrentWindow, PhysicalPosition } from '@tauri-apps/api/window';
import { useTranslation } from 'react-i18next';
import { clearSubtitleCuesRuntime, toggleSubtitleOverlayWindow } from '../runtime/audio-runtime';
import { isTauriRuntime } from '../runtime/tauri-runtime';
import type { SubtitleCueRuntime, SubtitleDisplaySegmentRuntime } from '../schema/audio-runtime';
import { useAppStore } from '../stores/app-store';
import { mixOpacity, withAlpha } from '../utils/color-alpha';

type OverlayStylePreset = {
  backgroundColor: string;
  backgroundOpacity: number;
  fontFamily?: string;
  opacity: number;
  textColor: string;
  textOpacity: number;
};

const overlayStylePresets: Record<'classic' | 'glass' | 'contrast', OverlayStylePreset> = {
  classic: {
    backgroundColor: '#111827',
    backgroundOpacity: 0.84,
    opacity: 0.88,
    textColor: '#fff8ef',
    textOpacity: 1,
  },
  glass: {
    backgroundColor: '#0f172a',
    backgroundOpacity: 0.46,
    opacity: 0.82,
    textColor: '#f8fafc',
    textOpacity: 0.94,
  },
  contrast: {
    backgroundColor: '#020617',
    backgroundOpacity: 0.96,
    opacity: 1,
    textColor: '#fef3c7',
    textOpacity: 1,
  },
};

const overlayThemeOptions = [
  { id: 'classic', labelKey: 'overlay.styleClassic', labelFallback: '经典深色', preset: overlayStylePresets.classic },
  { id: 'glass', labelKey: 'overlay.styleGlass', labelFallback: '玻璃轻透', preset: overlayStylePresets.glass },
  { id: 'contrast', labelKey: 'overlay.styleContrast', labelFallback: '高对比', preset: overlayStylePresets.contrast },
] as const;

const overlayFontSizeOptions = [18, 22, 24, 28, 32, 36, 42, 48] as const;

const overlayBackgroundOpacityOptions = [0, 0.25, 0.45, 0.65, 0.84, 1] as const;

const overlayTextColorOptions = [
  { id: 'warm-white', labelKey: 'overlay.textColorWarmWhite', labelFallback: '暖白', value: '#fff8ef' },
  { id: 'pure-white', labelKey: 'overlay.textColorPureWhite', labelFallback: '纯白', value: '#ffffff' },
  { id: 'amber', labelKey: 'overlay.textColorAmber', labelFallback: '琥珀', value: '#fef3c7' },
  { id: 'mint', labelKey: 'overlay.textColorMint', labelFallback: '薄荷绿', value: '#bbf7d0' },
  { id: 'sky', labelKey: 'overlay.textColorSky', labelFallback: '天蓝', value: '#bae6fd' },
  { id: 'rose', labelKey: 'overlay.textColorRose', labelFallback: '玫瑰粉', value: '#fecdd3' },
] as const;

type OverlayContextMenuState = {
  open: boolean;
  x: number;
  y: number;
};

type LockedRevealState = {
  interactive: boolean;
  visible: boolean;
};

type OverlayDragState = {
  pointerId: number;
  frameId: number | null;
  scaleFactor: number;
  startScreenX: number;
  startScreenY: number;
  startWindowX: number;
  startWindowY: number;
  targetX: number;
  targetY: number;
};

type OverlayResizeDirection = 'North' | 'South' | 'East' | 'West' | 'NorthEast' | 'NorthWest' | 'SouthEast' | 'SouthWest';

type OverlayResizeState = {
  direction: OverlayResizeDirection;
  frameId: number | null;
  pointerId: number;
  scaleFactor: number;
  startScreenX: number;
  startScreenY: number;
  startWindowHeight: number;
  startWindowWidth: number;
  startWindowX: number;
  startWindowY: number;
  targetHeight: number;
  targetWidth: number;
  targetX: number;
  targetY: number;
};

type OverlayDisplaySegment = SubtitleDisplaySegmentRuntime & {
  id: string;
};

const LOCK_BUTTON_HOTSPOT_HEIGHT = 36;
const LOCK_BUTTON_HOTSPOT_INSET = 6;
const LOCK_BUTTON_HOTSPOT_WIDTH = 65;
const LOCK_BUTTON_POLL_INTERVAL_MS = 120;
const MIN_OVERLAY_WIDTH = 220;
const MIN_OVERLAY_HEIGHT = 72;
const MIN_SUBTITLE_FONT_SCALE = 0.78;
const TRANSLATION_FONT_SCALE = 0.82;
const OVERLAY_RESIZE_DEBOUNCE_MS = 300;

const OVERLAY_RESIZE_HANDLES: ReadonlyArray<{ className: string; direction: OverlayResizeDirection }> = [
  { className: 'subtitle-overlay-resize-handle-north', direction: 'North' },
  { className: 'subtitle-overlay-resize-handle-south', direction: 'South' },
  { className: 'subtitle-overlay-resize-handle-east', direction: 'East' },
  { className: 'subtitle-overlay-resize-handle-west', direction: 'West' },
  { className: 'subtitle-overlay-resize-handle-northeast', direction: 'NorthEast' },
  { className: 'subtitle-overlay-resize-handle-northwest', direction: 'NorthWest' },
  { className: 'subtitle-overlay-resize-handle-southeast', direction: 'SouthEast' },
  { className: 'subtitle-overlay-resize-handle-southwest', direction: 'SouthWest' },
];

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function splitDisplayLines(text: string) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function getCueDisplaySegments(cue: SubtitleCueRuntime): OverlayDisplaySegment[] {
  const explicitSegments = cue.displaySegments
    ?.filter((segment) => segment.sourceText.trim().length > 0 || segment.translatedText.trim().length > 0)
    .map((segment, index) => ({
      ...segment,
      id: `${cue.cueId}-segment-${index}`,
    }));

  if (explicitSegments && explicitSegments.length > 0) {
    return explicitSegments;
  }

  const sourceLines = splitDisplayLines(cue.displaySourceText || cue.sourceText);
  const translatedLines = splitDisplayLines(cue.translatedText);
  const segmentCount = Math.max(sourceLines.length, translatedLines.length);

  return Array.from({ length: segmentCount }, (_, index) => ({
    id: `${cue.cueId}-fallback-${index}`,
    sourceText: sourceLines[index] ?? '',
    translatedText: translatedLines[index] ?? '',
    pending: Boolean(sourceLines[index]) && !translatedLines[index],
  })).filter((segment) => segment.sourceText || segment.translatedText);
}

function toOverlayAxisPercent(position: number, workAreaStart: number, availableDistance: number) {
  if (availableDistance <= 0) {
    return 0;
  }

  return clamp(Math.round(((position - workAreaStart) / availableDistance) * 100), 0, 100);
}

function calculateOverlayResizeBounds(resizeState: OverlayResizeState, screenX: number, screenY: number) {
  const deltaX = Math.round((screenX - resizeState.startScreenX) * resizeState.scaleFactor);
  const deltaY = Math.round((screenY - resizeState.startScreenY) * resizeState.scaleFactor);
  const minWidth = Math.round(MIN_OVERLAY_WIDTH * resizeState.scaleFactor);
  const minHeight = Math.round(MIN_OVERLAY_HEIGHT * resizeState.scaleFactor);
  let width = resizeState.startWindowWidth;
  let height = resizeState.startWindowHeight;
  let x = resizeState.startWindowX;
  let y = resizeState.startWindowY;

  if (resizeState.direction.includes('East')) {
    width = Math.max(minWidth, resizeState.startWindowWidth + deltaX);
  }

  if (resizeState.direction.includes('South')) {
    height = Math.max(minHeight, resizeState.startWindowHeight + deltaY);
  }

  if (resizeState.direction.includes('West')) {
    width = Math.max(minWidth, resizeState.startWindowWidth - deltaX);
    x = resizeState.startWindowX + (resizeState.startWindowWidth - width);
  }

  if (resizeState.direction.includes('North')) {
    height = Math.max(minHeight, resizeState.startWindowHeight - deltaY);
    y = resizeState.startWindowY + (resizeState.startWindowHeight - height);
  }

  return { height, width, x, y };
}

function calculateLockedRevealState(
  pointer: { x: number; y: number },
  overlayPosition: { x: number; y: number },
  overlaySize: { height: number; width: number },
): LockedRevealState {
  const insideOverlayBounds =
    pointer.x >= overlayPosition.x &&
    pointer.x <= overlayPosition.x + overlaySize.width &&
    pointer.y >= overlayPosition.y &&
    pointer.y <= overlayPosition.y + overlaySize.height;
  const hotspotLeft = overlayPosition.x + Math.max(0, overlaySize.width - LOCK_BUTTON_HOTSPOT_WIDTH - LOCK_BUTTON_HOTSPOT_INSET);
  const hotspotTop = overlayPosition.y + LOCK_BUTTON_HOTSPOT_INSET;
  const insideLockHotspot =
    insideOverlayBounds &&
    pointer.x >= hotspotLeft &&
    pointer.x <= hotspotLeft + LOCK_BUTTON_HOTSPOT_WIDTH &&
    pointer.y >= hotspotTop &&
    pointer.y <= hotspotTop + LOCK_BUTTON_HOTSPOT_HEIGHT;

  return { interactive: insideLockHotspot, visible: insideOverlayBounds };
}

export const subtitleOverlayPageHelpers = {
  calculateLockedRevealState,
  calculateOverlayResizeBounds,
  clamp,
  splitDisplayLines,
  getCueDisplaySegments,
  toOverlayAxisPercent,
};

function SubtitleOverlayPage() {
  const { t } = useTranslation();
  const menuText = (key: string, defaultValue: string) => t(key, { defaultValue });
  const audioRuntimeSnapshot = useAppStore((state) => state.audioRuntimeSnapshot);
  const configDraft = useAppStore((state) => state.configDraft);
  const setAudioRuntimeSnapshot = useAppStore((state) => state.setAudioRuntimeSnapshot);
  const setRuntimeSnapshot = useAppStore((state) => state.setRuntimeSnapshot);
  const updateSubtitleDraft = useAppStore((state) => state.updateSubtitleDraft);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const lastAppliedWindowSizeRef = useRef<{ width: number; height: number } | null>(null);
  const programmaticResizeRef = useRef(false);
  const dragInProgressRef = useRef(false);
  const dragStateRef = useRef<OverlayDragState | null>(null);
  const resizeInProgressRef = useRef(false);
  const resizeStateRef = useRef<OverlayResizeState | null>(null);
  const resizeDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hovered, setHovered] = useState(false);
  const [lockedReveal, setLockedReveal] = useState<LockedRevealState>({ interactive: false, visible: false });
  const [contextMenu, setContextMenu] = useState<OverlayContextMenuState>({ open: false, x: 0, y: 0 });
  const recentCues = audioRuntimeSnapshot.subtitleOverlay.recentCues;

  const displayCues = useMemo(() => {
    return [...recentCues]
      .filter((cue) => getCueDisplaySegments(cue).length > 0)
      .reverse();
  }, [recentCues]);
  const displaySegmentCount = useMemo(
    () => displayCues.reduce((count, cue) => count + getCueDisplaySegments(cue).length, 0),
    [displayCues],
  );

  const {
    overlayBackgroundColor,
    overlayBackgroundOpacity,
    overlayFontFamily,
    overlayFontSize,
    overlayHeight,
    overlayLocked,
    overlayOpacity,
    overlayTextColor,
    overlayTextOpacity,
    overlayWidth,
    overlayX,
    overlayY,
  } = configDraft.subtitles;
  const effectiveOverlayFontSize = clamp(Math.round(overlayFontSize || 24), 16, 48);
  const overlayPositionRef = useRef({ x: overlayX, y: overlayY });
  const cardStyle = useMemo(() => {
    const backgroundAlpha = mixOpacity(overlayOpacity, overlayBackgroundOpacity);
    const textAlpha = mixOpacity(overlayOpacity, overlayTextOpacity);
    const effectStrength = Math.min(1, Math.max(0, overlayOpacity));
    const backgroundEffectStrength = backgroundAlpha;

    return {
      '--subtitle-overlay-background': withAlpha(overlayBackgroundColor, backgroundAlpha),
      '--subtitle-overlay-border': withAlpha('#ffffff', 0.12 * backgroundEffectStrength),
      '--subtitle-overlay-shadow': withAlpha('#000000', 0.28 * backgroundEffectStrength),
      '--subtitle-overlay-blur': `${Math.round(12 * backgroundEffectStrength)}px`,
      '--subtitle-overlay-font-family': overlayFontFamily,
      '--subtitle-overlay-source-shadow': withAlpha('#000000', 0.48 * effectStrength),
      '--subtitle-overlay-translation-shadow': withAlpha('#000000', 0.42 * effectStrength),
      '--subtitle-overlay-text': withAlpha(overlayTextColor, textAlpha),
      '--subtitle-overlay-translation-opacity': `${Math.max(0.4, textAlpha * 0.92)}`,
    } as React.CSSProperties;
  }, [overlayBackgroundColor, overlayBackgroundOpacity, overlayFontFamily, overlayOpacity, overlayTextColor, overlayTextOpacity]);
  const showLockToggle = overlayLocked ? (isTauriRuntime() ? lockedReveal.visible : hovered) : hovered;

  useEffect(() => {
    overlayPositionRef.current = { x: overlayX, y: overlayY };
  }, [overlayX, overlayY]);

  useEffect(() => {
    return () => {
      const dragState = dragStateRef.current;
      if (dragState && dragState.frameId !== null) {
        window.cancelAnimationFrame(dragState.frameId);
      }

      const resizeState = resizeStateRef.current;
      if (resizeState && resizeState.frameId !== null) {
        window.cancelAnimationFrame(resizeState.frameId);
      }
    };
  }, []);

  useEffect(() => {
    if (isTauriRuntime() || !contextMenu.open) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) {
        return;
      }

      setContextMenu((current) => (current.open ? { ...current, open: false } : current));
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      setContextMenu((current) => (current.open ? { ...current, open: false } : current));
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [contextMenu.open]);

  const syncNativeOverlayRegion = async (rounded = true) => {
    if (!isTauriRuntime()) {
      return;
    }

    await invoke('sync_subtitle_overlay_region', { rounded });
  };

  const syncNativeOverlayWindowState = async (locked = overlayLocked, rounded = locked, hotspotInteractive = false) => {
    if (!isTauriRuntime()) {
      return;
    }

    await invoke('sync_subtitle_overlay_window_state', { hotspotInteractive, locked, rounded });
  };

  const syncOverlayDraftPosition = async (position?: PhysicalPosition) => {
    if (!isTauriRuntime()) {
      return;
    }

    const windowHandle = getCurrentWindow();
    const [monitor, windowSize, nextPosition] = await Promise.all([
      currentMonitor(),
      windowHandle.outerSize(),
      position ? Promise.resolve(position) : windowHandle.outerPosition(),
    ]);

    if (!monitor) {
      return;
    }

    const availableWidth = Math.max(1, monitor.workArea.size.width - windowSize.width);
    const availableHeight = Math.max(1, monitor.workArea.size.height - windowSize.height);
    const nextOverlayX = toOverlayAxisPercent(nextPosition.x, monitor.workArea.position.x, availableWidth);
    const nextOverlayY = toOverlayAxisPercent(nextPosition.y, monitor.workArea.position.y, availableHeight);

    if (overlayPositionRef.current.x === nextOverlayX && overlayPositionRef.current.y === nextOverlayY) {
      return;
    }

    overlayPositionRef.current = { x: nextOverlayX, y: nextOverlayY };
    updateSubtitleDraft({ overlayX: nextOverlayX, overlayY: nextOverlayY });
  };

  const flushDraggedWindowPosition = async () => {
    const dragState = dragStateRef.current;
    if (!dragState) {
      return;
    }

    dragState.frameId = null;
    await getCurrentWindow().setPosition(new PhysicalPosition(dragState.targetX, dragState.targetY));
  };

  const scheduleDraggedWindowPosition = () => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.frameId !== null) {
      return;
    }

    dragState.frameId = window.requestAnimationFrame(() => {
      void flushDraggedWindowPosition();
    });
  };

  const finishOverlayDrag = async (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (dragState.frameId !== null) {
      window.cancelAnimationFrame(dragState.frameId);
      dragState.frameId = null;
    }

    dragStateRef.current = null;
    dragInProgressRef.current = false;

    const finalPosition = new PhysicalPosition(dragState.targetX, dragState.targetY);
    await getCurrentWindow().setPosition(finalPosition);
    await syncOverlayDraftPosition(finalPosition);
  };

  const handleOverlayPointerDown = async (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isTauriRuntime() || overlayLocked || event.button !== 0) {
      return;
    }

    const targetElement = event.currentTarget;

    const target = event.target;
    if (
      target instanceof Element &&
      target.closest('.subtitle-overlay-toggle-lock')
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const windowHandle = getCurrentWindow();
    const [windowPosition, scaleFactor] = await Promise.all([windowHandle.outerPosition(), windowHandle.scaleFactor()]);

    dragStateRef.current = {
      pointerId: event.pointerId,
      frameId: null,
      scaleFactor,
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      startWindowX: windowPosition.x,
      startWindowY: windowPosition.y,
      targetX: windowPosition.x,
      targetY: windowPosition.y,
    };
    dragInProgressRef.current = true;
    targetElement.setPointerCapture(event.pointerId);
  };

  const handleOverlayPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();

    const deltaX = Math.round((event.screenX - dragState.startScreenX) * dragState.scaleFactor);
    const deltaY = Math.round((event.screenY - dragState.startScreenY) * dragState.scaleFactor);
    dragState.targetX = dragState.startWindowX + deltaX;
    dragState.targetY = dragState.startWindowY + deltaY;

    scheduleDraggedWindowPosition();
  };

  const flushResizedWindowBounds = async () => {
    const resizeState = resizeStateRef.current;
    if (!resizeState) {
      return;
    }

    resizeState.frameId = null;

    const windowHandle = getCurrentWindow();
    await windowHandle.setPosition(new PhysicalPosition(resizeState.targetX, resizeState.targetY));
    await windowHandle.setSize(
      new LogicalSize(
        Math.round(resizeState.targetWidth / resizeState.scaleFactor),
        Math.round(resizeState.targetHeight / resizeState.scaleFactor),
      ),
    );
  };

  const scheduleResizedWindowBounds = () => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.frameId !== null) {
      return;
    }

    resizeState.frameId = window.requestAnimationFrame(() => {
      void flushResizedWindowBounds();
    });
  };

  const handleResizePointerDown = async (direction: OverlayResizeDirection, event: React.PointerEvent<HTMLDivElement>) => {
    if (!isTauriRuntime() || overlayLocked || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const targetElement = event.currentTarget;

    const windowHandle = getCurrentWindow();
    const [windowPosition, windowSize, scaleFactor] = await Promise.all([
      windowHandle.outerPosition(),
      windowHandle.outerSize(),
      windowHandle.scaleFactor(),
    ]);

    resizeStateRef.current = {
      direction,
      frameId: null,
      pointerId: event.pointerId,
      scaleFactor,
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      startWindowHeight: windowSize.height,
      startWindowWidth: windowSize.width,
      startWindowX: windowPosition.x,
      startWindowY: windowPosition.y,
      targetHeight: windowSize.height,
      targetWidth: windowSize.width,
      targetX: windowPosition.x,
      targetY: windowPosition.y,
    };
    resizeInProgressRef.current = true;
    targetElement.setPointerCapture(event.pointerId);
  };

  const handleResizePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const nextBounds = calculateOverlayResizeBounds(resizeState, event.screenX, event.screenY);
    resizeState.targetWidth = nextBounds.width;
    resizeState.targetHeight = nextBounds.height;
    resizeState.targetX = nextBounds.x;
    resizeState.targetY = nextBounds.y;

    scheduleResizedWindowBounds();
  };

  const finishOverlayResize = async (event: React.PointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (resizeState.frameId !== null) {
      window.cancelAnimationFrame(resizeState.frameId);
      resizeState.frameId = null;
    }

    const finalPosition = new PhysicalPosition(resizeState.targetX, resizeState.targetY);
    const finalWidth = Math.max(MIN_OVERLAY_WIDTH, Math.round(resizeState.targetWidth / resizeState.scaleFactor));
    const finalHeight = Math.max(MIN_OVERLAY_HEIGHT, Math.round(resizeState.targetHeight / resizeState.scaleFactor));

    await getCurrentWindow().setPosition(finalPosition);
    await getCurrentWindow().setSize(new LogicalSize(finalWidth, finalHeight));
    await syncNativeOverlayRegion();

    lastAppliedWindowSizeRef.current = { width: finalWidth, height: finalHeight };
    await syncOverlayDraftPosition(finalPosition);
    updateSubtitleDraft({ overlayHeight: finalHeight, overlayWidth: finalWidth });

    resizeStateRef.current = null;
    resizeInProgressRef.current = false;
  };

  useEffect(() => {
    if (!overlayLocked) {
      setLockedReveal((current) => (current.visible || current.interactive ? { interactive: false, visible: false } : current));
      return undefined;
    }

    if (!isTauriRuntime()) {
      return undefined;
    }

    let disposed = false;
    let inFlight = false;
    const windowHandle = getCurrentWindow();

    const syncRevealState = async () => {
      if (disposed || inFlight) {
        return;
      }

      inFlight = true;

      try {
        const [pointer, overlayPosition, overlaySize] = await Promise.all([
          cursorPosition(),
          windowHandle.outerPosition(),
          windowHandle.outerSize(),
        ]);

        if (disposed) {
          return;
        }

        const nextReveal = calculateLockedRevealState(pointer, overlayPosition, overlaySize);

        setLockedReveal((current) => {
          if (current.visible === nextReveal.visible && current.interactive === nextReveal.interactive) {
            return current;
          }

          return nextReveal;
        });
      } catch {
        if (!disposed) {
          setLockedReveal((current) => (current.visible || current.interactive ? { interactive: false, visible: false } : current));
        }
      } finally {
        inFlight = false;
      }
    };

    void syncRevealState();
    const intervalId = window.setInterval(() => {
      void syncRevealState();
    }, LOCK_BUTTON_POLL_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [overlayLocked]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return undefined;
    }

    if (overlayLocked) {
      setHovered(false);
      setContextMenu((current) => (current.open ? { ...current, open: false } : current));
    }

    void syncNativeOverlayWindowState(overlayLocked, true, lockedReveal.interactive);

    return undefined;
  }, [lockedReveal.interactive, overlayLocked]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return undefined;
    }

    let disposed = false;

    const applyWindowGeometry = async () => {
      const windowHandle = getCurrentWindow();
      const logicalWidth = Math.max(220, Math.round(overlayWidth));
      const logicalHeight = Math.max(72, Math.round(overlayHeight));
      const lastSize = lastAppliedWindowSizeRef.current;

      if (!lastSize || lastSize.width !== logicalWidth || lastSize.height !== logicalHeight) {
        lastAppliedWindowSizeRef.current = { width: logicalWidth, height: logicalHeight };
        programmaticResizeRef.current = true;
        await windowHandle.setSize(new LogicalSize(logicalWidth, logicalHeight));
      }

      await syncNativeOverlayRegion();

      const monitor = await currentMonitor();
      if (!monitor || disposed) {
        return;
      }

      const windowSize = await windowHandle.outerSize();
      const availableWidth = Math.max(0, monitor.workArea.size.width - windowSize.width);
      const availableHeight = Math.max(0, monitor.workArea.size.height - windowSize.height);
      const nextX = monitor.workArea.position.x + Math.round((availableWidth * clamp(overlayX, 0, 100)) / 100);
      const nextY = monitor.workArea.position.y + Math.round((availableHeight * clamp(overlayY, 0, 100)) / 100);

      await windowHandle.setPosition(new PhysicalPosition(nextX, nextY));
    };

    void applyWindowGeometry();

    return () => {
      disposed = true;
    };
  }, [overlayHeight, overlayWidth]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return undefined;
    }

    let disposed = false;
    let unlistenWindowResize: (() => void) | undefined;

    const windowHandle = getCurrentWindow();
    void windowHandle.onResized(async () => {
      if (disposed) {
        return;
      }

      await syncNativeOverlayRegion();

      if (resizeInProgressRef.current) {
        return;
      }

      if (programmaticResizeRef.current) {
        programmaticResizeRef.current = false;
        return;
      }

      if (resizeDebounceTimerRef.current !== null) {
        clearTimeout(resizeDebounceTimerRef.current);
      }

      resizeDebounceTimerRef.current = setTimeout(async () => {
        resizeDebounceTimerRef.current = null;

        const scaleFactor = await windowHandle.scaleFactor();
        const windowSize = await windowHandle.innerSize();
        const monitor = await currentMonitor();
        if (!monitor) {
          return;
        }

        const nextOverlayWidth = Math.max(220, Math.round(windowSize.width / scaleFactor));
        const nextOverlayHeight = Math.max(72, Math.round(windowSize.height / scaleFactor));

        updateSubtitleDraft({
          overlayHeight: nextOverlayHeight,
          overlayWidth: nextOverlayWidth,
        });

        await syncOverlayDraftPosition();
      }, OVERLAY_RESIZE_DEBOUNCE_MS);
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }

      unlistenWindowResize = unlisten;
    });

    return () => {
      disposed = true;
      if (resizeDebounceTimerRef.current !== null) {
        clearTimeout(resizeDebounceTimerRef.current);
        resizeDebounceTimerRef.current = null;
      }
      unlistenWindowResize?.();
    };
  }, [updateSubtitleDraft]);

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const appRoot = document.getElementById('root');
    const previousRootStyle = root.getAttribute('style');
    const previousBodyStyle = body.getAttribute('style');
    const previousAppRootStyle = appRoot?.getAttribute('style') ?? null;

    root.style.background = 'transparent';
    root.style.overflow = 'hidden';
    body.style.background = 'transparent';
    body.style.overflow = 'hidden';
    body.style.margin = '0';
    if (appRoot) {
      appRoot.style.background = 'transparent';
      appRoot.style.minHeight = '0';
      appRoot.style.width = 'fit-content';
    }

    if (!isTauriRuntime()) {
      return () => {
        if (previousRootStyle === null) {
          root.removeAttribute('style');
        } else {
          root.setAttribute('style', previousRootStyle);
        }

        if (previousBodyStyle === null) {
          body.removeAttribute('style');
        } else {
          body.setAttribute('style', previousBodyStyle);
        }

        if (appRoot) {
          if (previousAppRootStyle === null) {
            appRoot.removeAttribute('style');
          } else {
            appRoot.setAttribute('style', previousAppRootStyle);
          }
        }
      };
    }

    let disposed = false;

    const applyWindowPosition = async () => {
      if (dragInProgressRef.current) {
        return;
      }

      const monitor = await currentMonitor();
      if (!monitor || disposed) {
        return;
      }

      const windowHandle = getCurrentWindow();
      const [windowSize, currentPosition] = await Promise.all([windowHandle.outerSize(), windowHandle.outerPosition()]);
      const availableWidth = Math.max(0, monitor.workArea.size.width - windowSize.width);
      const availableHeight = Math.max(0, monitor.workArea.size.height - windowSize.height);
      const requestedOverlayX = clamp(overlayX, 0, 100);
      const requestedOverlayY = clamp(overlayY, 0, 100);
      const currentOverlayX = toOverlayAxisPercent(currentPosition.x, monitor.workArea.position.x, availableWidth);
      const currentOverlayY = toOverlayAxisPercent(currentPosition.y, monitor.workArea.position.y, availableHeight);

      if (currentOverlayX === requestedOverlayX && currentOverlayY === requestedOverlayY) {
        return;
      }

      const nextX = monitor.workArea.position.x + Math.round((availableWidth * requestedOverlayX) / 100);
      const nextY = monitor.workArea.position.y + Math.round((availableHeight * requestedOverlayY) / 100);

      await windowHandle.setPosition(new PhysicalPosition(nextX, nextY));
    };

    void applyWindowPosition();

    return () => {
      disposed = true;

      if (previousRootStyle === null) {
        root.removeAttribute('style');
      } else {
        root.setAttribute('style', previousRootStyle);
      }

      if (previousBodyStyle === null) {
        body.removeAttribute('style');
      } else {
        body.setAttribute('style', previousBodyStyle);
      }

      if (appRoot) {
        if (previousAppRootStyle === null) {
          appRoot.removeAttribute('style');
        } else {
          appRoot.setAttribute('style', previousAppRootStyle);
        }
      }
    };
  }, [overlayX, overlayY]);

  const handleContextMenu = async (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (overlayLocked) {
      return;
    }

    if (isTauriRuntime()) {
      const contextMenuHandle = await Menu.new({
        items: [
          {
            id: 'overlay-theme',
            text: menuText('overlay.themeMenu', '主题'),
            items: overlayThemeOptions.map((option) => ({
              checked: matchesOverlayStylePreset(option.preset),
              id: `overlay-theme-${option.id}`,
              text: menuText(option.labelKey, option.labelFallback),
              action: () => applyOverlayStylePreset(option.preset),
            })),
          },
          {
            id: 'overlay-font-size',
            text: menuText('overlay.fontSizeMenu', '字号'),
            items: overlayFontSizeOptions.map((fontSize) => ({
              checked: effectiveOverlayFontSize === fontSize,
              id: `overlay-font-size-${fontSize}`,
              text: `${fontSize}px`,
              action: () => applyOverlayFontSize(fontSize),
            })),
          },
          {
            id: 'overlay-background-opacity',
            text: menuText('overlay.backgroundOpacityMenu', '背景透明度'),
            items: overlayBackgroundOpacityOptions.map((opacity) => ({
              checked: Math.abs(overlayBackgroundOpacity - opacity) < 0.01,
              id: `overlay-background-opacity-${Math.round(opacity * 100)}`,
              text: `${Math.round(opacity * 100)}%`,
              action: () => applyOverlayBackgroundOpacity(opacity),
            })),
          },
          {
            id: 'overlay-text-color',
            text: menuText('overlay.textColorMenu', '字体颜色'),
            items: overlayTextColorOptions.map((option) => ({
              checked: overlayTextColor.toLowerCase() === option.value,
              id: `overlay-text-color-${option.id}`,
              text: menuText(option.labelKey, option.labelFallback),
              action: () => applyOverlayTextColor(option.value),
            })),
          },
          { item: 'Separator' },
          {
            id: 'overlay-lock',
            text: t('overlay.lockAction'),
            action: () => {
              updateSubtitleDraft({ overlayLocked: true });
            },
          },
          {
            id: 'overlay-hide',
            text: menuText('overlay.hideAction', '隐藏字幕悬浮窗'),
            action: () => {
              void hideSubtitleOverlayWindow();
            },
          },
          {
            id: 'overlay-clear',
            text: menuText('overlay.clearAction', '清空字幕'),
            action: () => {
              void clearSubtitleOverlayCues();
            },
          },
        ],
      });

      try {
        await contextMenuHandle.popup(new LogicalPosition(event.clientX, event.clientY), getCurrentWindow());
      } finally {
        await contextMenuHandle.close().catch(() => undefined);
      }

      return;
    }

    const estimatedMenuWidth = 208;
    const estimatedMenuHeight = 332;
    const nextX = Math.min(event.clientX, Math.max(12, window.innerWidth - estimatedMenuWidth));
    const nextY = Math.min(event.clientY, Math.max(12, window.innerHeight - estimatedMenuHeight));

    setContextMenu({ open: true, x: nextX, y: nextY });
  };

  const applyOverlayStylePreset = (preset: OverlayStylePreset) => {
    updateSubtitleDraft({
      overlayBackgroundColor: preset.backgroundColor,
      overlayBackgroundOpacity: preset.backgroundOpacity,
      overlayFontFamily: preset.fontFamily ?? overlayFontFamily,
      overlayOpacity: preset.opacity,
      overlayTextColor: preset.textColor,
      overlayTextOpacity: preset.textOpacity,
    });
    setContextMenu((current) => ({ ...current, open: false }));
  };

  const matchesOverlayStylePreset = (preset: OverlayStylePreset) => {
    return (
      overlayBackgroundColor.toLowerCase() === preset.backgroundColor.toLowerCase() &&
      Math.abs(overlayBackgroundOpacity - preset.backgroundOpacity) < 0.01 &&
      Math.abs(overlayOpacity - preset.opacity) < 0.01 &&
      overlayTextColor.toLowerCase() === preset.textColor.toLowerCase() &&
      Math.abs(overlayTextOpacity - preset.textOpacity) < 0.01
    );
  };

  const applyOverlayFontSize = (fontSize: number) => {
    updateSubtitleDraft({ overlayFontSize: fontSize });
    setContextMenu((current) => ({ ...current, open: false }));
  };

  const applyOverlayBackgroundOpacity = (opacity: number) => {
    updateSubtitleDraft({ overlayBackgroundOpacity: opacity });
    setContextMenu((current) => ({ ...current, open: false }));
  };

  const applyOverlayTextColor = (color: string) => {
    updateSubtitleDraft({ overlayTextColor: color });
    setContextMenu((current) => ({ ...current, open: false }));
  };

  const hideSubtitleOverlayWindow = async () => {
    const snapshot = await toggleSubtitleOverlayWindow();
    setRuntimeSnapshot(snapshot);
    setContextMenu((current) => ({ ...current, open: false }));
  };

  const clearSubtitleOverlayCues = async () => {
    const snapshot = await clearSubtitleCuesRuntime();
    setAudioRuntimeSnapshot(snapshot);
    setContextMenu((current) => ({ ...current, open: false }));
  };

  const lockSubtitleOverlay = () => {
    updateSubtitleDraft({ overlayLocked: true });
    setContextMenu((current) => ({ ...current, open: false }));
  };

  return (
    <div
      className={overlayLocked ? 'subtitle-overlay-root subtitle-overlay-root-locked' : 'subtitle-overlay-root'}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => {
        if (!overlayLocked) {
          setHovered(true);
        }
      }}
      onMouseLeave={() => {
        if (!overlayLocked) {
          setHovered(false);
        }
      }}
      onPointerCancel={(event) => {
        void finishOverlayDrag(event);
      }}
      onPointerDown={(event) => {
        void handleOverlayPointerDown(event);
      }}
      onPointerMove={handleOverlayPointerMove}
      onPointerUp={(event) => {
        void finishOverlayDrag(event);
      }}
      style={{ color: overlayTextColor, fontFamily: overlayFontFamily }}
    >
      {!overlayLocked && isTauriRuntime()
        ? OVERLAY_RESIZE_HANDLES.map(({ className, direction }) => (
            <div
              aria-label={`resize-${direction.toLowerCase()}`}
              className={`subtitle-overlay-resize-handle ${className}`}
              key={direction}
              onPointerCancel={(event) => {
                void finishOverlayResize(event);
              }}
              onPointerDown={(event) => {
                void handleResizePointerDown(direction, event);
              }}
              onPointerMove={handleResizePointerMove}
              onPointerUp={(event) => {
                void finishOverlayResize(event);
              }}
              role="presentation"
            />
          ))
        : null}
      <div
        className={isTauriRuntime() ? 'subtitle-overlay-lyrics subtitle-overlay-lyrics-window-sized' : 'subtitle-overlay-lyrics'}
        style={cardStyle}
      >
        {showLockToggle ? (
          <button
            className="subtitle-overlay-toggle-lock"
            onBlur={() => {
              if (overlayLocked) {
                setLockedReveal((current) => ({ ...current, interactive: false }));
              }
            }}
            onClick={() => {
              if (overlayLocked) {
                setLockedReveal({ interactive: false, visible: false });
              }
              updateSubtitleDraft({ overlayLocked: !overlayLocked });
            }}
            onMouseEnter={() => {
              if (overlayLocked) {
                setLockedReveal((current) => ({ ...current, interactive: true, visible: true }));
              }
            }}
            onMouseLeave={() => {
              if (overlayLocked) {
                setLockedReveal((current) => ({ ...current, interactive: false }));
              }
            }}
            onMouseDown={(event) => event.stopPropagation()}
            type="button"
          >
            {overlayLocked ? t('overlay.unlockAction') : t('overlay.lockAction')}
          </button>
        ) : null}
        {displayCues.length > 0 ? (
          <div className="subtitle-overlay-cues">
            {displayCues.map((cue, cueIndex) => {
              const cueSegments = getCueDisplaySegments(cue);
              const cueScale = displayCues.length > 1
                ? 0.72 + 0.28 * (cueIndex / (displayCues.length - 1))
                : 1;
              const densityScale = Math.max(MIN_SUBTITLE_FONT_SCALE, 1 - Math.max(0, displaySegmentCount - 4) * 0.04);
              const fontScale = Math.max(MIN_SUBTITLE_FONT_SCALE, cueScale * densityScale);
              const sourceFontSize = `${Math.round(effectiveOverlayFontSize * fontScale)}px`;
              const translationFontSize = `${Math.round(effectiveOverlayFontSize * TRANSLATION_FONT_SCALE * fontScale)}px`;

              return (
                <div className="subtitle-overlay-cue" key={cue.cueId}>
                  {cueSegments.map((segment) => (
                    <div
                      className={segment.pending ? 'subtitle-overlay-segment subtitle-overlay-segment-pending' : 'subtitle-overlay-segment'}
                      key={segment.id}
                    >
                      {segment.sourceText ? (
                        <p className="subtitle-overlay-source" style={{ fontSize: sourceFontSize }}>
                          {segment.sourceText}
                        </p>
                      ) : null}
                      <p className="subtitle-overlay-translation" style={{ fontSize: translationFontSize }}>
                        {segment.translatedText || '\u00a0'}
                      </p>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        ) : (
          <>
            <h1 className="subtitle-overlay-source" style={{ fontSize: `${effectiveOverlayFontSize}px` }}>
              {t('overlay.previewTitleEnglish', { defaultValue: 'Subtitles ready' })}
            </h1>
            <h1
              className="subtitle-overlay-translation"
              style={{ fontSize: `${Math.round(effectiveOverlayFontSize * TRANSLATION_FONT_SCALE)}px` }}
            >
              {t('overlay.previewTitle')}
            </h1>
          </>
        )}
      </div>
      {!isTauriRuntime() && contextMenu.open ? (
        <div
          className="subtitle-overlay-context-menu"
          ref={contextMenuRef}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onMouseDown={(event) => event.stopPropagation()}
          role="menu"
        >
          <div className="subtitle-overlay-context-menu-title">{menuText('overlay.contextMenuTitle', '字幕悬浮窗')}</div>
          <div className="subtitle-overlay-context-menu-submenu" role="none">
            <button className="subtitle-overlay-context-menu-item" type="button">
              <span>{menuText('overlay.themeMenu', '主题')}</span>
              <span aria-hidden="true">&gt;</span>
            </button>
            <div className="subtitle-overlay-context-submenu-panel" role="menu">
              {overlayThemeOptions.map((option) => (
                <button
                  className="subtitle-overlay-context-menu-item"
                  key={option.id}
                  onClick={() => applyOverlayStylePreset(option.preset)}
                  type="button"
                >
                  {matchesOverlayStylePreset(option.preset) ? '\u2713 ' : ''}
                  {menuText(option.labelKey, option.labelFallback)}
                </button>
              ))}
            </div>
          </div>
          <div className="subtitle-overlay-context-menu-submenu" role="none">
            <button className="subtitle-overlay-context-menu-item" type="button">
              <span>{menuText('overlay.fontSizeMenu', '字号')}</span>
              <span aria-hidden="true">&gt;</span>
            </button>
            <div className="subtitle-overlay-context-submenu-panel" role="menu">
              {overlayFontSizeOptions.map((fontSize) => (
                <button
                  className="subtitle-overlay-context-menu-item"
                  key={fontSize}
                  onClick={() => applyOverlayFontSize(fontSize)}
                  type="button"
                >
                  {effectiveOverlayFontSize === fontSize ? '\u2713 ' : ''}
                  {fontSize}px
                </button>
              ))}
            </div>
          </div>
          <div className="subtitle-overlay-context-menu-submenu" role="none">
            <button className="subtitle-overlay-context-menu-item" type="button">
              <span>{menuText('overlay.backgroundOpacityMenu', '背景透明度')}</span>
              <span aria-hidden="true">&gt;</span>
            </button>
            <div className="subtitle-overlay-context-submenu-panel" role="menu">
              {overlayBackgroundOpacityOptions.map((opacity) => (
                <button
                  className="subtitle-overlay-context-menu-item"
                  key={opacity}
                  onClick={() => applyOverlayBackgroundOpacity(opacity)}
                  type="button"
                >
                  {Math.abs(overlayBackgroundOpacity - opacity) < 0.01 ? '\u2713 ' : ''}
                  {Math.round(opacity * 100)}%
                </button>
              ))}
            </div>
          </div>
          <div className="subtitle-overlay-context-menu-submenu" role="none">
            <button className="subtitle-overlay-context-menu-item" type="button">
              <span>{menuText('overlay.textColorMenu', '字体颜色')}</span>
              <span aria-hidden="true">&gt;</span>
            </button>
            <div className="subtitle-overlay-context-submenu-panel" role="menu">
              {overlayTextColorOptions.map((option) => (
                <button
                  className="subtitle-overlay-context-menu-item subtitle-overlay-color-menu-item"
                  key={option.id}
                  onClick={() => applyOverlayTextColor(option.value)}
                  type="button"
                >
                  <span className="subtitle-overlay-color-swatch" style={{ backgroundColor: option.value }} />
                  <span>
                    {overlayTextColor.toLowerCase() === option.value ? '\u2713 ' : ''}
                    {menuText(option.labelKey, option.labelFallback)}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <button className="subtitle-overlay-context-menu-item" onClick={lockSubtitleOverlay} type="button">
            {t('overlay.lockAction')}
          </button>
          <button className="subtitle-overlay-context-menu-item" onClick={() => void hideSubtitleOverlayWindow()} type="button">
            {menuText('overlay.hideAction', '隐藏字幕悬浮窗')}
          </button>
          <button className="subtitle-overlay-context-menu-item" onClick={() => void clearSubtitleOverlayCues()} type="button">
            {menuText('overlay.clearAction', '清空字幕')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default SubtitleOverlayPage;
