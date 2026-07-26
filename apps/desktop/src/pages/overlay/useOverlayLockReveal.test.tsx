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
    mocks.scaleFactor.mockResolvedValue(1);
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
