import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OverlayContextMenu from './OverlayContextMenu';

describe('OverlayContextMenu', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('binds every menu action to the overlay controller', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const applyPreset = vi.fn();
    const applyFontSize = vi.fn();
    const applyOpacity = vi.fn();
    const applyTextColor = vi.fn();
    const lock = vi.fn();
    const hide = vi.fn().mockResolvedValue(undefined);
    const clear = vi.fn().mockResolvedValue(undefined);

    act(() => {
      root.render(
        <OverlayContextMenu
          applyOverlayBackgroundOpacity={applyOpacity}
          applyOverlayFontSize={applyFontSize}
          applyOverlayStylePreset={applyPreset}
          applyOverlayTextColor={applyTextColor}
          clearSubtitleOverlayCues={clear}
          contextMenu={{ open: true, x: 12, y: 24 }}
          effectiveOverlayFontSize={32}
          elementRef={createRef<HTMLDivElement>()}
          hideSubtitleOverlayWindow={hide}
          lockSubtitleOverlay={lock}
          matchesOverlayStylePreset={() => true}
          menuText={(key) => key}
          overlayBackgroundOpacity={0.7}
          overlayTextColor="#ffffff"
        />,
      );
    });

    const click = async (element: Element) => {
      await act(async () => {
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
      });
    };
    const panels = container.querySelectorAll('.subtitle-overlay-context-submenu-panel');
    await click(panels[0].querySelector('button')!);
    await click(panels[1].querySelector('button')!);
    await click(panels[2].querySelector('button')!);
    await click(panels[3].querySelector('button')!);
    const directActions = container.querySelectorAll('.subtitle-overlay-context-menu > .subtitle-overlay-context-menu-item');
    await click(directActions[0]);
    await click(directActions[1]);
    await click(directActions[2]);

    expect(applyPreset).toHaveBeenCalledOnce();
    expect(applyFontSize).toHaveBeenCalledOnce();
    expect(applyOpacity).toHaveBeenCalledOnce();
    expect(applyTextColor).toHaveBeenCalledOnce();
    expect(lock).toHaveBeenCalledOnce();
    expect(hide).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });
});
