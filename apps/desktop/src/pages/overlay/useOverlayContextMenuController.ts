import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';

import { LogicalPosition, Menu, getCurrentWindow } from '../../runtime/overlay-window-adapter';
import { useDesktopCapabilities } from '../../runtime/desktop-api-context';
import { overlayBackgroundOpacityOptions, overlayFontSizeOptions, overlayTextColorOptions,
  overlayThemeOptions, type OverlayContextMenuState, type OverlayStylePreset } from './overlayDomain';

type Options = {
  applyBackgroundOpacity: (opacity: number) => void;
  applyFontSize: (fontSize: number) => void;
  applyStylePreset: (preset: OverlayStylePreset) => void;
  applyTextColor: (color: string) => void;
  clearCues: () => void;
  effectiveFontSize: number;
  hideWindow: () => void;
  lockOverlay: () => void;
  matchesStylePreset: (preset: OverlayStylePreset) => boolean;
  menuText: (key: string) => string;
  overlayBackgroundOpacity: number;
  overlayLocked: boolean;
  overlayTextColor: string;
};

export function useOverlayContextMenuController(options: Options) {
  const { hasNativeShell } = useDesktopCapabilities();
  const [contextMenu, setContextMenu] = useState<OverlayContextMenuState>({ open: false, x: 0, y: 0 });
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu((current) => ({ ...current, open: false })), []);

  useEffect(() => {
    if (hasNativeShell || !contextMenu.open) return undefined;
    const handlePointerDown = (event: PointerEvent) => { if (!contextMenuRef.current?.contains(event.target as Node)) closeContextMenu(); };
    const handleEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') closeContextMenu(); };
    window.addEventListener('pointerdown', handlePointerDown); window.addEventListener('keydown', handleEscape);
    return () => { window.removeEventListener('pointerdown', handlePointerDown); window.removeEventListener('keydown', handleEscape); };
  }, [closeContextMenu, contextMenu.open, hasNativeShell]);

  const handleContextMenu = useCallback(async (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault(); event.stopPropagation();
    if (options.overlayLocked) return;
    if (hasNativeShell) {
      const menu = await Menu.new({ items: [
        { id: 'overlay-theme', text: options.menuText('overlay.themeMenu'), items: overlayThemeOptions.map((item) => ({ checked: options.matchesStylePreset(item.preset), id: `overlay-theme-${item.id}`, text: options.menuText(item.labelKey), action: () => options.applyStylePreset(item.preset) })) },
        { id: 'overlay-font-size', text: options.menuText('overlay.fontSizeMenu'), items: overlayFontSizeOptions.map((value) => ({ checked: options.effectiveFontSize === value, id: `overlay-font-size-${value}`, text: `${value}px`, action: () => options.applyFontSize(value) })) },
        { id: 'overlay-background-opacity', text: options.menuText('overlay.backgroundOpacityMenu'), items: overlayBackgroundOpacityOptions.map((value) => ({ checked: Math.abs(options.overlayBackgroundOpacity - value) < 0.01, id: `overlay-background-opacity-${Math.round(value * 100)}`, text: `${Math.round(value * 100)}%`, action: () => options.applyBackgroundOpacity(value) })) },
        { id: 'overlay-text-color', text: options.menuText('overlay.textColorMenu'), items: overlayTextColorOptions.map((item) => ({ checked: options.overlayTextColor.toLowerCase() === item.value, id: `overlay-text-color-${item.id}`, text: options.menuText(item.labelKey), action: () => options.applyTextColor(item.value) })) },
        { item: 'Separator' },
        { id: 'overlay-lock', text: options.menuText('overlay.lockAction'), action: options.lockOverlay },
        { id: 'overlay-hide', text: options.menuText('overlay.hideAction'), action: options.hideWindow },
        { id: 'overlay-clear', text: options.menuText('overlay.clearAction'), action: options.clearCues },
      ] });
      try { await menu.popup(new LogicalPosition(event.clientX, event.clientY), getCurrentWindow()); }
      finally { await menu.close().catch(() => undefined); }
      return;
    }
    setContextMenu({ open: true, x: Math.min(event.clientX, Math.max(12, window.innerWidth - 208)), y: Math.min(event.clientY, Math.max(12, window.innerHeight - 332)) });
  }, [options, hasNativeShell]);

  return { closeContextMenu, contextMenu, contextMenuRef, handleContextMenu, setContextMenu };
}
