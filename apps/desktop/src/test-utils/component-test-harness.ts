import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, vi } from 'vitest';

export interface DomHarnessOptions {
  /** beforeEach: vi.useFakeTimers(); afterEach: vi.useRealTimers(). */
  fakeTimers?: boolean;
  /** afterEach: vi.useRealTimers() only (tests opt into fake timers per-test). */
  realTimersAfterEach?: boolean;
  /** Runs in beforeEach before the container/root are created. */
  setup?: () => void | Promise<void>;
  /** Runs in afterEach before the root is unmounted. */
  beforeUnmount?: () => void | Promise<void>;
  /** Runs in afterEach after the root is unmounted and the container removed. */
  cleanup?: () => void | Promise<void>;
}

export interface DomTestHarness {
  container: HTMLDivElement;
  /**
   * Mutable on purpose (same contract as TestRootHandle): tests that unmount
   * mid-test call `remount()` (or assign a fresh root) so the shared afterEach
   * unmounts the active root. Unmounting an already-unmounted root is a no-op.
   */
  root: Root;
  /** Renders the node on the current root inside act(). */
  render(node: ReactNode): Promise<void>;
  /** Unmounts the current root inside act() (safe to call again in afterEach). */
  unmount(): Promise<void>;
  /** Re-creates the root on the existing container after a mid-test unmount. */
  remount(): void;
}

/**
 * Registers the shared DOM mount boilerplate (act environment flag, container
 * appended to document.body, concurrent root) as beforeEach/afterEach hooks
 * and returns a stable handle. Call once at describe/file scope:
 *
 *   const view = registerDomHarness({ fakeTimers: true });
 *   it('...', async () => { await view.render(<Comp />); ... });
 */
export function registerDomHarness(options: DomHarnessOptions = {}): DomTestHarness {
  const view: DomTestHarness = {
    container: undefined as unknown as HTMLDivElement,
    root: undefined as unknown as Root,
    async render(node: ReactNode) {
      await act(async () => {
        view.root.render(node);
      });
    },
    async unmount() {
      await act(async () => {
        view.root.unmount();
      });
    },
    remount() {
      view.root = createRoot(view.container);
    },
  };

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    if (options.fakeTimers) {
      vi.useFakeTimers();
    }
    await options.setup?.();
    view.container = document.createElement('div');
    document.body.appendChild(view.container);
    view.root = createRoot(view.container);
  });

  afterEach(async () => {
    await options.beforeUnmount?.();
    await view.unmount();
    view.container.remove();
    if (options.fakeTimers || options.realTimersAfterEach) {
      vi.useRealTimers();
    }
    await options.cleanup?.();
  });

  return view;
}
