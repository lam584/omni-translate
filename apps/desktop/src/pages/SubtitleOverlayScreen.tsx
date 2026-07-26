import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';

import { clearSubtitleCuesRuntime, toggleSubtitleOverlayWindow } from '../runtime/audio-runtime';
import { isTauriRuntime } from '../runtime/tauri-runtime';
import { useAppStore } from '../stores/app-store';
import { mixOpacity, withAlpha } from '../utils/color-alpha';
import OverlayContextMenu from './overlay/OverlayContextMenu';
import OverlayResizeHandles from './overlay/OverlayResizeHandles';
import SubtitleOverlayContent from './overlay/SubtitleOverlayContent';
import { clamp, getCueDisplaySegments, overlayFallbackText, subtitleOverlayPageHelpers,
  MAX_OVERLAY_FONT_SIZE, MIN_OVERLAY_FONT_SIZE, toOverlayAxisPercent,
  type OverlayDragState, type OverlayResizeState } from './overlay/overlayDomain';
import { useOverlayContextMenuController } from './overlay/useOverlayContextMenuController';
import { useOverlayGeometrySync } from './overlay/useOverlayGeometrySync';
import { useOverlayLockReveal } from './overlay/useOverlayLockReveal';
import { useOverlayNativeEventSync } from './overlay/useOverlayNativeEventSync';
import { useOverlayPointerInteractions } from './overlay/useOverlayPointerInteractions';
import { useOverlayStyleController } from './overlay/useOverlayStyleController';
import { useOverlayWindowController } from './overlay/useOverlayWindowController';

export { subtitleOverlayPageHelpers };

function SubtitleOverlayPage() {
  const { t } = useTranslation();
  const audioRuntimeSnapshot = useAppStore((state) => state.audioRuntimeSnapshot);
  const configDraft = useAppStore((state) => state.configDraft);
  const setAudioRuntimeSnapshot = useAppStore((state) => state.setAudioRuntimeSnapshot);
  const setRuntimeSnapshot = useAppStore((state) => state.setRuntimeSnapshot);
  const updateSubtitleDraft = useAppStore((state) => state.updateSubtitleDraft);
  const pushRuntimeNotification = useAppStore((state) => state.pushRuntimeNotification);
  const lastAppliedWindowSizeRef = useRef<{ width: number; height: number } | null>(null);
  const programmaticResizeRef = useRef(false);
  const dragInProgressRef = useRef(false);
  const dragStateRef = useRef<OverlayDragState | null>(null);
  const resizeInProgressRef = useRef(false);
  const resizeStateRef = useRef<OverlayResizeState | null>(null);
  const resizeDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hovered, setHovered] = useState(false);
  const { recentCues } = audioRuntimeSnapshot.subtitleOverlay;
  const displayCues = useMemo(() => [...recentCues].filter((cue) => getCueDisplaySegments(cue).length > 0).reverse(), [recentCues]);
  const { overlayBackgroundColor, overlayBackgroundOpacity, overlayFontFamily, overlayFontSize, overlayHeight,
    overlayLocked, overlayOpacity, overlayTextColor, overlayTextOpacity, overlayWidth, overlayX, overlayY } = configDraft.subtitles;
  const { lockedReveal, setLockedReveal } = useOverlayLockReveal(overlayLocked);
  const effectiveOverlayFontSize = clamp(
    Math.round(overlayFontSize || 24),
    MIN_OVERLAY_FONT_SIZE,
    MAX_OVERLAY_FONT_SIZE,
  );
  const overlayPositionRef = useRef({ x: overlayX, y: overlayY });
  useEffect(() => {
    overlayPositionRef.current = { x: overlayX, y: overlayY };
  }, [overlayX, overlayY]);
  const menuText = useCallback((key: string) => t(key, { defaultValue: overlayFallbackText(key) }), [t]);
  const styleController = useOverlayStyleController({ overlayBackgroundColor, overlayBackgroundOpacity, overlayFontFamily,
    overlayOpacity, overlayTextColor, overlayTextOpacity, updateSubtitleDraft });

  const hideWindow = useCallback(async () => {
    setRuntimeSnapshot(await toggleSubtitleOverlayWindow());
  }, [setRuntimeSnapshot]);
  const clearCues = useCallback(async () => {
    setAudioRuntimeSnapshot(await clearSubtitleCuesRuntime());
  }, [setAudioRuntimeSnapshot]);
  const lockOverlay = useCallback(() => updateSubtitleDraft({ overlayLocked: true }), [updateSubtitleDraft]);
  const toggleOverlayLock = useCallback(() => {
    setLockedReveal({ interactive: false, visible: false });
    updateSubtitleDraft({ overlayLocked: !overlayLocked });
    if (overlayLocked && isTauriRuntime()) {
      void invoke('unlock_subtitle_overlay').catch((error) => {
        pushRuntimeNotification({
          id: `subtitle-overlay-unlock-failed-${Date.now()}`,
          level: 'error',
          source: 'subtitle-overlay',
          message: `Failed to persist subtitle overlay unlock: ${error instanceof Error ? error.message : String(error)}`,
          emittedAt: new Date().toISOString(),
        });
      });
    }
  }, [overlayLocked, pushRuntimeNotification, setLockedReveal, updateSubtitleDraft]);
  const contextController = useOverlayContextMenuController({
    applyBackgroundOpacity: styleController.applyOverlayBackgroundOpacity,
    applyFontSize: styleController.applyOverlayFontSize,
    applyStylePreset: styleController.applyOverlayStylePreset,
    applyTextColor: styleController.applyOverlayTextColor,
    clearCues,
    effectiveFontSize: effectiveOverlayFontSize,
    hideWindow,
    lockOverlay,
    matchesStylePreset: styleController.matchesOverlayStylePreset,
    menuText,
    overlayBackgroundOpacity,
    overlayLocked,
    overlayTextColor,
  });
  const closeContextMenu = contextController.closeContextMenu;

  const updatePosition = useCallback(({ x, y }: { x: number; y: number }) => updateSubtitleDraft({ overlayX: x, overlayY: y }), [updateSubtitleDraft]);
  const updateSize = useCallback(({ overlayHeight: height, overlayWidth: width }: { overlayHeight: number; overlayWidth: number }) => updateSubtitleDraft({ overlayHeight: height, overlayWidth: width }), [updateSubtitleDraft]);
  const windowController = useOverlayWindowController({ overlayLocked, overlayPositionRef, toAxisPercent: toOverlayAxisPercent,
    updatePosition, dragStateRef, resizeStateRef, lastAppliedWindowSizeRef, updateSize });
  const { syncOverlayDraftPosition: syncOverlayPosition } = windowController;
  const pointerInteractions = useOverlayPointerInteractions({ overlayLocked, dragStateRef, resizeStateRef, dragInProgressRef,
    resizeInProgressRef, scheduleDraggedWindowPosition: windowController.scheduleDraggedWindowPosition,
    scheduleResizedWindowBounds: windowController.scheduleResizedWindowBounds,
    syncOverlayDraftPosition: syncOverlayPosition, persistOverlayBounds: windowController.persistOverlayBounds });
  const syncOverlayDraftPosition = useCallback(async () => {
    await syncOverlayPosition();
  }, [syncOverlayPosition]);

  useOverlayGeometrySync({ dragInProgressRef, lastAppliedWindowSizeRef, overlayHeight, overlayWidth, overlayX, overlayY,
    programmaticResizeRef, syncNativeOverlayRegion: windowController.syncNativeOverlayRegion });
  useOverlayNativeEventSync({ lockedRevealInteractive: lockedReveal.interactive, overlayLocked, programmaticResizeRef,
    resizeDebounceTimerRef, resizeInProgressRef, setContextMenu: contextController.setContextMenu, setHovered,
    syncNativeOverlayRegion: windowController.syncNativeOverlayRegion,
    syncNativeOverlayWindowState: windowController.syncNativeOverlayWindowState,
    syncOverlayDraftPosition, updateSubtitleDraft });

  const cardStyle = useMemo(() => {
    const backgroundAlpha = mixOpacity(overlayOpacity, overlayBackgroundOpacity);
    const textAlpha = mixOpacity(overlayOpacity, overlayTextOpacity);
    return {
      '--subtitle-overlay-background': withAlpha(overlayBackgroundColor, backgroundAlpha),
      '--subtitle-overlay-border': withAlpha('#ffffff', 0.12 * backgroundAlpha),
      '--subtitle-overlay-shadow': withAlpha('#000000', 0.28 * backgroundAlpha),
      '--subtitle-overlay-blur': `${Math.round(12 * backgroundAlpha)}px`,
      '--subtitle-overlay-font-family': overlayFontFamily,
      '--subtitle-overlay-source-shadow': withAlpha('#000000', 0.48 * overlayOpacity),
      '--subtitle-overlay-translation-shadow': withAlpha('#000000', 0.42 * overlayOpacity),
      '--subtitle-overlay-text': withAlpha(overlayTextColor, textAlpha),
      '--subtitle-overlay-translation-opacity': `${Math.max(0.4, textAlpha * 0.92)}`,
    } as React.CSSProperties;
  }, [overlayBackgroundColor, overlayBackgroundOpacity, overlayFontFamily, overlayOpacity, overlayTextColor, overlayTextOpacity]);

  const closeAfter = <T extends unknown[]>(action: (...args: T) => void) => (...args: T) => { action(...args); closeContextMenu(); };
  const closeAfterAsync = <T extends unknown[]>(action: (...args: T) => Promise<void>) => async (...args: T) => {
    try { await action(...args); } finally { closeContextMenu(); }
  };
  return (
    <div className={overlayLocked ? 'subtitle-overlay-root subtitle-overlay-root-locked' : 'subtitle-overlay-root'}
      onContextMenu={contextController.handleContextMenu}
      onMouseEnter={() => { if (!overlayLocked) setHovered(true); }}
      onMouseLeave={() => { if (!overlayLocked) setHovered(false); }}
      onPointerCancel={(event) => void pointerInteractions.finishOverlayDrag(event)}
      onPointerDown={(event) => void pointerInteractions.handleOverlayPointerDown(event)}
      onPointerMove={pointerInteractions.handleOverlayPointerMove}
      onPointerUp={(event) => void pointerInteractions.finishOverlayDrag(event)}
      style={{ color: overlayTextColor, fontFamily: overlayFontFamily }}>
      <OverlayResizeHandles visible={!overlayLocked && isTauriRuntime()}
        onPointerDown={(direction, event) => void pointerInteractions.handleResizePointerDown(direction, event)}
        onPointerMove={pointerInteractions.handleResizePointerMove}
        onPointerFinish={(event) => void pointerInteractions.finishOverlayResize(event)} />
      <SubtitleOverlayContent cardStyle={cardStyle} displayCues={displayCues}
        effectiveFontSize={effectiveOverlayFontSize} overlayLocked={overlayLocked}
        showLockToggle={overlayLocked ? (isTauriRuntime() ? lockedReveal.visible : hovered) : hovered}
        windowSized={isTauriRuntime()} lockLabel={overlayLocked ? menuText('overlay.unlockAction') : menuText('overlay.lockAction')}
        previewSource={t('overlay.previewTitleEnglish', { defaultValue: 'Subtitles ready' })} previewTranslation={t('overlay.previewTitle')}
        onLockBlur={() => { if (overlayLocked) setLockedReveal((current) => ({ ...current, interactive: false })); }}
        onLockHover={(nextHovered) => { if (overlayLocked) setLockedReveal((current) => ({ ...current, interactive: nextHovered, visible: nextHovered || current.visible })); }}
        onLockToggle={toggleOverlayLock} />
      {!isTauriRuntime() && contextController.contextMenu.open ? (
        <OverlayContextMenu applyOverlayBackgroundOpacity={closeAfter(styleController.applyOverlayBackgroundOpacity)}
          applyOverlayFontSize={closeAfter(styleController.applyOverlayFontSize)} applyOverlayStylePreset={closeAfter(styleController.applyOverlayStylePreset)}
          applyOverlayTextColor={closeAfter(styleController.applyOverlayTextColor)} clearSubtitleOverlayCues={closeAfterAsync(clearCues)}
          contextMenu={contextController.contextMenu} elementRef={contextController.contextMenuRef} effectiveOverlayFontSize={effectiveOverlayFontSize}
          hideSubtitleOverlayWindow={closeAfterAsync(hideWindow)} lockSubtitleOverlay={closeAfter(lockOverlay)}
          matchesOverlayStylePreset={styleController.matchesOverlayStylePreset} menuText={menuText}
          overlayBackgroundOpacity={overlayBackgroundOpacity} overlayTextColor={overlayTextColor} />
      ) : null}
    </div>
  );
}

export default SubtitleOverlayPage;
