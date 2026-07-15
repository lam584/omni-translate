import type { RefObject } from 'react';
import {
  overlayBackgroundOpacityOptions, overlayFontSizeOptions, overlayTextColorOptions,
  overlayThemeOptions, type OverlayContextMenuState, type OverlayStylePreset,
} from './overlayDomain';

type OverlayContextMenuProps = {
  contextMenu: OverlayContextMenuState;
  elementRef: RefObject<HTMLDivElement | null>;
  menuText: (key: string) => string;
  effectiveOverlayFontSize: number;
  overlayBackgroundOpacity: number;
  overlayTextColor: string;
  applyOverlayStylePreset: (preset: OverlayStylePreset) => void;
  matchesOverlayStylePreset: (preset: OverlayStylePreset) => boolean;
  applyOverlayFontSize: (fontSize: number) => void;
  applyOverlayBackgroundOpacity: (opacity: number) => void;
  applyOverlayTextColor: (color: string) => void;
  lockSubtitleOverlay: () => void;
  hideSubtitleOverlayWindow: () => Promise<void>;
  clearSubtitleOverlayCues: () => Promise<void>;
};

export default function OverlayContextMenu({
  contextMenu, elementRef, menuText, effectiveOverlayFontSize, overlayBackgroundOpacity,
  overlayTextColor, applyOverlayStylePreset, matchesOverlayStylePreset, applyOverlayFontSize,
  applyOverlayBackgroundOpacity, applyOverlayTextColor, lockSubtitleOverlay,
  hideSubtitleOverlayWindow, clearSubtitleOverlayCues,
}: OverlayContextMenuProps) {
  return (
    <div className="subtitle-overlay-context-menu" ref={elementRef}
      style={{ left: contextMenu.x, top: contextMenu.y }}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onMouseDown={(event) => event.stopPropagation()} role="menu">
      <div className="subtitle-overlay-context-menu-title">{menuText('overlay.contextMenuTitle')}</div>
      <div className="subtitle-overlay-context-menu-submenu" role="none">
        <button className="subtitle-overlay-context-menu-item" type="button"><span>{menuText('overlay.themeMenu')}</span><span aria-hidden="true">&gt;</span></button>
        <div className="subtitle-overlay-context-submenu-panel" role="menu">
          {overlayThemeOptions.map((option) => <button className="subtitle-overlay-context-menu-item" key={option.id} onClick={() => applyOverlayStylePreset(option.preset)} type="button">
            {matchesOverlayStylePreset(option.preset) ? '\u2713 ' : ''}{menuText(option.labelKey)}
          </button>)}
        </div>
      </div>
      <div className="subtitle-overlay-context-menu-submenu" role="none">
        <button className="subtitle-overlay-context-menu-item" type="button"><span>{menuText('overlay.fontSizeMenu')}</span><span aria-hidden="true">&gt;</span></button>
        <div className="subtitle-overlay-context-submenu-panel" role="menu">
          {overlayFontSizeOptions.map((fontSize) => <button className="subtitle-overlay-context-menu-item" key={fontSize} onClick={() => applyOverlayFontSize(fontSize)} type="button">
            {effectiveOverlayFontSize === fontSize ? '\u2713 ' : ''}{fontSize}px
          </button>)}
        </div>
      </div>
      <div className="subtitle-overlay-context-menu-submenu" role="none">
        <button className="subtitle-overlay-context-menu-item" type="button"><span>{menuText('overlay.backgroundOpacityMenu')}</span><span aria-hidden="true">&gt;</span></button>
        <div className="subtitle-overlay-context-submenu-panel" role="menu">
          {overlayBackgroundOpacityOptions.map((opacity) => <button className="subtitle-overlay-context-menu-item" key={opacity} onClick={() => applyOverlayBackgroundOpacity(opacity)} type="button">
            {Math.abs(overlayBackgroundOpacity - opacity) < 0.01 ? '\u2713 ' : ''}{Math.round(opacity * 100)}%
          </button>)}
        </div>
      </div>
      <div className="subtitle-overlay-context-menu-submenu" role="none">
        <button className="subtitle-overlay-context-menu-item" type="button"><span>{menuText('overlay.textColorMenu')}</span><span aria-hidden="true">&gt;</span></button>
        <div className="subtitle-overlay-context-submenu-panel" role="menu">
          {overlayTextColorOptions.map((option) => <button className="subtitle-overlay-context-menu-item subtitle-overlay-color-menu-item" key={option.id} onClick={() => applyOverlayTextColor(option.value)} type="button">
            <span className="subtitle-overlay-color-swatch" style={{ backgroundColor: option.value }} />
            <span>{overlayTextColor.toLowerCase() === option.value ? '\u2713 ' : ''}{menuText(option.labelKey)}</span>
          </button>)}
        </div>
      </div>
      <button className="subtitle-overlay-context-menu-item" onClick={lockSubtitleOverlay} type="button">{menuText('overlay.lockAction')}</button>
      <button className="subtitle-overlay-context-menu-item" onClick={() => void hideSubtitleOverlayWindow()} type="button">{menuText('overlay.hideAction')}</button>
      <button className="subtitle-overlay-context-menu-item" onClick={() => void clearSubtitleOverlayCues()} type="button">{menuText('overlay.clearAction')}</button>
    </div>
  );
}
