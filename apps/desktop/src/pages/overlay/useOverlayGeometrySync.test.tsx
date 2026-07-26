import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  currentMonitor: vi.fn(),
  outerSize: vi.fn(),
  outerPosition: vi.fn(),
  setPosition: vi.fn(),
  setSize: vi.fn(),
}));

vi.mock('../../runtime/desktop-api-context', () => ({
  useDesktopCapabilities: () => ({ hasNativeShell: true }),
}));
vi.mock('../../runtime/overlay-window-adapter', () => ({
  currentMonitor: () => mocks.currentMonitor(),
  LogicalSize: class LogicalSize { constructor(public width: number, public height: number) {} },
  PhysicalPosition: class PhysicalPosition { constructor(public x: number, public y: number) {} },
  getCurrentWindow: () => ({
    outerSize: mocks.outerSize,
    outerPosition: mocks.outerPosition,
    setPosition: mocks.setPosition,
    setSize: mocks.setSize,
  }),
}));

import { useOverlayGeometrySync } from './useOverlayGeometrySync';

describe('useOverlayGeometrySync drag guard', () => {
  it('applies persisted overlay heights up to the expanded 720px limit', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.currentMonitor.mockResolvedValue({ workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } } });
    mocks.outerSize.mockResolvedValue({ width: 960, height: 700 });
    mocks.outerPosition.mockResolvedValue({ x: 0, y: 0 });
    mocks.setPosition.mockResolvedValue(undefined);
    mocks.setSize.mockResolvedValue(undefined);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      useOverlayGeometrySync({
        dragInProgressRef: useRef(false),
        lastAppliedWindowSizeRef: useRef(null),
        overlayHeight: 700,
        overlayWidth: 960,
        overlayX: 50,
        overlayY: 50,
        programmaticResizeRef: useRef(false),
        syncNativeOverlayRegion: vi.fn().mockResolvedValue(undefined),
      });
      return null;
    }

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 960, height: 700 }));
    await act(async () => root.unmount());
    container.remove();
  });

  it('does not reapply persisted position while a user drag is active', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.currentMonitor.mockResolvedValue({ workArea: { position: { x: 0, y: 0 }, size: { width: 1000, height: 800 } } });
    mocks.outerSize.mockResolvedValue({ width: 400, height: 100 });
    mocks.outerPosition.mockResolvedValue({ x: 0, y: 0 });
    mocks.setPosition.mockResolvedValue(undefined);
    mocks.setSize.mockResolvedValue(undefined);
    const syncRegion = vi.fn().mockResolvedValue(undefined);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      useOverlayGeometrySync({
        dragInProgressRef: useRef(true),
        lastAppliedWindowSizeRef: useRef({ width: 400, height: 100 }),
        overlayHeight: 100,
        overlayWidth: 400,
        overlayX: 50,
        overlayY: 50,
        programmaticResizeRef: useRef(false),
        syncNativeOverlayRegion: syncRegion,
      });
      return null;
    }

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.currentMonitor).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    container.remove();
  });
});
