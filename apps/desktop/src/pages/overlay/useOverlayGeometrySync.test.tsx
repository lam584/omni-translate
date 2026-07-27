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

// The hook mixes two coordinate spaces on purpose: `setSize` takes LOGICAL
// pixels (DPI-independent, so the persisted draft means the same thing on
// every monitor) while monitor work area, `outerSize` and `setPosition` are
// PHYSICAL. The fixtures below therefore model a real HiDPI desktop —
// physical window size = round(logical x scaleFactor) — with 1.5 as the
// default, because a 1.0 fixture makes the two spaces indistinguishable and
// hides every scale-dependent mistake.
const DEFAULT_SCALE_FACTOR = 1.5;

type Harness = {
  overlayHeight?: number;
  overlayWidth?: number;
  overlayX?: number;
  overlayY?: number;
  dragInProgress?: boolean;
  lastAppliedWindowSize?: { width: number; height: number } | null;
  syncNativeOverlayRegion?: () => Promise<void>;
};

async function renderGeometry(options: Harness = {}) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function HarnessComponent() {
    useOverlayGeometrySync({
      dragInProgressRef: useRef(options.dragInProgress ?? false),
      lastAppliedWindowSizeRef: useRef(options.lastAppliedWindowSize ?? null),
      overlayHeight: options.overlayHeight ?? 700,
      overlayWidth: options.overlayWidth ?? 960,
      overlayX: options.overlayX ?? 50,
      overlayY: options.overlayY ?? 50,
      programmaticResizeRef: useRef(false),
      syncNativeOverlayRegion: options.syncNativeOverlayRegion ?? vi.fn().mockResolvedValue(undefined),
    });
    return null;
  }

  await act(async () => {
    root.render(<HarnessComponent />);
    await Promise.resolve();
    await Promise.resolve();
  });

  return async () => {
    await act(async () => root.unmount());
    container.remove();
  };
}

function positionTargets() {
  return mocks.setPosition.mock.calls.map((call) => call[0]);
}

function installWindow(scaleFactor: number, logical: { width: number; height: number }, monitor = {
  workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } },
}) {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.currentMonitor.mockResolvedValue(monitor);
  // What the OS reports back for a window sized in logical pixels.
  mocks.outerSize.mockResolvedValue({
    width: Math.round(logical.width * scaleFactor),
    height: Math.round(logical.height * scaleFactor),
  });
  mocks.outerPosition.mockResolvedValue({ x: 0, y: 0 });
  mocks.setPosition.mockResolvedValue(undefined);
  mocks.setSize.mockResolvedValue(undefined);
}

describe('useOverlayGeometrySync coordinate spaces', () => {
  // Expected values are derived from the production formulas:
  //   physical = round(logical * scale)
  //   available = max(0, workArea.size - physical)
  //   position  = workArea.position + round(available * percent / 100)
  it.each([
    // scale, physical size, availableW/H on a 1920x1080 work area, position at 50%/50%
    [1.25, { width: 1200, height: 875 }, { x: 360, y: 103 }],
    [1.5, { width: 1440, height: 1050 }, { x: 240, y: 15 }],
    [2, { width: 1920, height: 1400 }, { x: 0, y: 0 }],
  ] as const)(
    'sizes in logical px and positions in physical px at scaleFactor %s',
    async (scaleFactor, physicalSize, expectedPosition) => {
      installWindow(scaleFactor, { width: 960, height: 700 });

      const cleanup = await renderGeometry();

      // Size is logical and therefore identical at every scale factor: the
      // persisted 960x700 draft must not shrink on a HiDPI monitor.
      expect(mocks.setSize).toHaveBeenCalledTimes(1);
      expect(mocks.setSize.mock.calls[0][0]).toEqual({ width: 960, height: 700 });

      // The OS reported this physical size for that logical request...
      await expect(mocks.outerSize()).resolves.toEqual(physicalSize);
      // ...and the centered position is computed in that same physical space.
      // Both mount effects position the window (the second one re-reads
      // outerPosition, which has not caught up with the first move yet), so
      // assert the TARGET of every call rather than a call count.
      expect(positionTargets()).not.toHaveLength(0);
      for (const target of positionTargets()) expect(target).toEqual(expectedPosition);

      await cleanup();
    },
  );

  it('adds the work-area origin so a secondary monitor is not treated as (0,0)', async () => {
    installWindow(DEFAULT_SCALE_FACTOR, { width: 960, height: 700 }, {
      workArea: { position: { x: 1920, y: -120 }, size: { width: 1920, height: 1080 } },
    });

    const cleanup = await renderGeometry();

    // available = 1920-1440 = 480 wide, 1080-1050 = 30 tall; 50%/50% of that,
    // offset by the secondary monitor's origin.
    for (const target of positionTargets()) expect(target).toEqual({ x: 1920 + 240, y: -120 + 15 });
    expect(positionTargets()).not.toHaveLength(0);

    await cleanup();
  });

  it.each([
    // Percent extremes land exactly on the work-area edges (no drift).
    [0, 0, { x: 0, y: 0 }],
    [100, 100, { x: 480, y: 30 }],
    // Out-of-range persisted percentages are clamped, not extrapolated.
    [140, -40, { x: 480, y: 0 }],
  ] as const)('clamps persisted overlayX=%s overlayY=%s to the work area', async (overlayX, overlayY, expected) => {
    installWindow(DEFAULT_SCALE_FACTOR, { width: 960, height: 700 });

    const cleanup = await renderGeometry({ overlayX, overlayY });

    for (const target of positionTargets()) expect(target).toEqual(expected);
    expect(positionTargets()).not.toHaveLength(0);

    await cleanup();
  });

  it('clamps the requested logical size into the supported overlay range', async () => {
    installWindow(DEFAULT_SCALE_FACTOR, { width: 1280, height: 720 });

    const cleanup = await renderGeometry({ overlayWidth: 4_000, overlayHeight: 4_000 });

    // MAX_OVERLAY_WIDTH / MAX_OVERLAY_HEIGHT, still expressed logically.
    expect(mocks.setSize.mock.calls[0][0]).toEqual({ width: 1280, height: 720 });

    await cleanup();
  });

  it('skips the resize IPC when the applied logical size already matches', async () => {
    installWindow(DEFAULT_SCALE_FACTOR, { width: 960, height: 700 });

    const cleanup = await renderGeometry({ lastAppliedWindowSize: { width: 960, height: 700 } });

    expect(mocks.setSize).not.toHaveBeenCalled();
    // Positioning still runs: only the size IPC is deduplicated.
    expect(positionTargets()).not.toHaveLength(0);

    await cleanup();
  });

  it('does not reapply persisted position while a user drag is active', async () => {
    installWindow(DEFAULT_SCALE_FACTOR, { width: 400, height: 100 });
    const syncRegion = vi.fn().mockResolvedValue(undefined);

    const cleanup = await renderGeometry({
      dragInProgress: true,
      lastAppliedWindowSize: { width: 400, height: 100 },
      overlayHeight: 100,
      overlayWidth: 400,
      syncNativeOverlayRegion: syncRegion,
    });

    // Only the size-effect pass consults the monitor; the drag guard aborts
    // the position-effect pass before it reads geometry.
    expect(mocks.currentMonitor).toHaveBeenCalledTimes(1);

    await cleanup();
  });
});
