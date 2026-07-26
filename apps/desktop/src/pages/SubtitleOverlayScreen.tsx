import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { clearSubtitleCuesRuntime, toggleSubtitleOverlayWindow } from '../runtime/audio-runtime';
import { desktopApiV2 } from '../runtime/desktop-api-v2';
import { isTauriRuntime } from '../runtime/tauri-runtime';
import { useAppStore } from '../stores/app-store';
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
import { buildSubtitleOverlayCssVariables } from './overlay/overlayTypography';

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
    overlayLocked, overlayOpacity, overlaySourceTextStyle, overlayTextColor, overlayTextOpacity,
    overlayTranslationTextStyle, overlayWidth, overlayX, overlayY } = configDraft.subtitles;
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
    overlayOpacity, overlaySourceTextStyle, overlayTextColor, overlayTextOpacity,
    overlayTranslationTextStyle, updateSubtitleDraft });

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
      void desktopApiV2.overlay.unlock().catch((error) => {
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

  const cardStyle = useMemo(() => buildSubtitleOverlayCssVariables(configDraft.subtitles), [configDraft.subtitles]);

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
      style={{ fontFamily: overlayFontFamily }}>
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
