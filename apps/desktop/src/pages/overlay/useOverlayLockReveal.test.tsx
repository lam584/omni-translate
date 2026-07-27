import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  cursorPosition: vi.fn(),
  outerPosition: vi.fn(),
  outerSize: vi.fn(),
  scaleFactor: vi.fn(),
}));

vi.mock('../../runtime/desktop-api-context', () => ({
  useDesktopCapabilities: () => ({ hasNativeShell: mocks.isTauri() }),
}));
vi.mock('../../runtime/overlay-window-adapter', () => ({
  cursorPosition: () => mocks.cursorPosition(),
  getCurrentWindow: () => ({
    outerPosition: mocks.outerPosition,
    outerSize: mocks.outerSize,
    scaleFactor: mocks.scaleFactor,
  }),
}));

import { useOverlayLockReveal } from './useOverlayLockReveal';

describe('useOverlayLockReveal', () => {
  let container: HTMLDivElement;
  let root: Root;
  let controller: ReturnType<typeof useOverlayLockReveal>;

  function Harness({ locked }: { locked: boolean }) {
    controller = useOverlayLockReveal(locked);
    return null;
  }

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.isTauri.mockReturnValue(true);
    mocks.cursorPosition.mockResolvedValue({ x: 480, y: 215 });
    mocks.outerPosition.mockResolvedValue({ x: 100, y: 200 });
    mocks.outerSize.mockResolvedValue({ width: 400, height: 100 });
    // Default to a HiDPI desktop: the hotspot is sized in LOGICAL px and
    // compared against PHYSICAL cursor/window coordinates, so a 1.0 fixture
    // would make every scale mistake invisible.
    mocks.scaleFactor.mockResolvedValue(1.5);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('reveals the lock hotspot, avoids duplicate state, and hides it when unlocked', async () => {
    await act(async () => {
      root.render(<Harness locked />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(controller.lockedReveal).toEqual({ visible: true, interactive: true });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
      root.render(<Harness locked={false} />);
      await Promise.resolve();
    });
    expect(controller.lockedReveal).toEqual({ visible: false, interactive: false });
  });

  // The unlock hotspot is LOCK_BUTTON_HOTSPOT_WIDTH(65) x HEIGHT(36) logical
  // px, inset by 6, anchored to the overlay's top-right corner; everything is
  // multiplied by the scale factor before being compared with the physical
  // cursor position. With the overlay at (100,200) sized 400x100 physical:
  //   left = 100 + 400 - 71*scale, top = 200 + 6*scale
  //   right = left + 65*scale,     bottom = top + 36*scale
  // so the same pixel is inside the hotspot at one DPI and outside at another.
  it.each([
    // scale, pointer, expected reveal state, why this probe matters
    [1.25, { x: 480, y: 215 }, { visible: true, interactive: true }, 'well inside at every scale'],
    [1.25, { x: 400, y: 215 }, { visible: true, interactive: false }, 'left of the narrow 1.25 hotspot (starts at 411.25)'],
    [1.5, { x: 400, y: 215 }, { visible: true, interactive: true }, 'the wider 1.5 hotspot starts at 393.5'],
    [1.25, { x: 480, y: 258 }, { visible: true, interactive: false }, 'below the short 1.25 hotspot (ends at 252.5)'],
    [1.5, { x: 480, y: 258 }, { visible: true, interactive: true }, 'the taller 1.5 hotspot ends at 263'],
    [1.5, { x: 360, y: 215 }, { visible: true, interactive: false }, 'left of the 1.5 hotspot'],
    [2, { x: 360, y: 215 }, { visible: true, interactive: true }, 'the 2.0 hotspot reaches back to 358'],
    [1.5, { x: 90, y: 215 }, { visible: false, interactive: false }, 'outside the overlay entirely'],
  ] as const)('maps the cursor to the DPI-scaled unlock hotspot at scale %s (%s)', async (scaleFactor, pointer, expected, _why) => {
    mocks.scaleFactor.mockResolvedValue(scaleFactor);
    mocks.cursorPosition.mockResolvedValue(pointer);

    await act(async () => {
      root.render(<Harness locked />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(controller.lockedReveal).toEqual(expected);
  });

  it('does nothing for a locked browser-preview overlay', async () => {
    mocks.isTauri.mockReturnValue(false);
    await act(async () => root.render(<Harness locked />));
    expect(mocks.cursorPosition).not.toHaveBeenCalled();
  });

  it('hides stale interaction state after polling failure, including interactive-only state', async () => {
    await act(async () => root.render(<Harness locked />));
    await act(async () => controller.setLockedReveal({ visible: false, interactive: true }));
    mocks.cursorPosition.mockRejectedValue(new Error('cursor IPC failed'));

    await act(async () => vi.advanceTimersByTimeAsync(120));
    expect(controller.lockedReveal).toEqual({ visible: false, interactive: false });

    await act(async () => vi.advanceTimersByTimeAsync(120));
    expect(controller.lockedReveal).toEqual({ visible: false, interactive: false });
  });

  it('ignores a successful or failed poll that settles after disposal', async () => {
    let resolveCursor!: (value: { x: number; y: number }) => void;
    mocks.cursorPosition.mockImplementationOnce(() => new Promise((resolve) => { resolveCursor = resolve; }));
    await act(async () => root.render(<Harness locked />));
    await act(async () => root.unmount());
    resolveCursor({ x: 480, y: 215 });
    await Promise.resolve();

    root = createRoot(container);
    let rejectCursor!: (error: unknown) => void;
    mocks.cursorPosition.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCursor = reject; }));
    await act(async () => root.render(<Harness locked />));
    await act(async () => root.unmount());
    rejectCursor(new Error('late failure'));
    await Promise.resolve();

    root = createRoot(container);
  });
});
