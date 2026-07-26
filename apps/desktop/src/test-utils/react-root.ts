import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

export interface TestRootHandle {
  container: HTMLDivElement;
  /**
   * Mutable on purpose: tests that unmount and re-create the root mid-test
   * must assign the fresh root back (`view.root = createRoot(view.container)`)
   * so `cleanup()` unmounts the active root.
   */
  root: Root;
  /** Renders the node on the current root inside act(). */
  render(node: ReactNode): Promise<void>;
  /** Unmounts the current root inside act() and removes the container. */
  cleanup(): Promise<void>;
}

/**
 * Shared React mount boilerplate for component tests: enables the act()
 * environment, appends a fresh container to document.body and creates a
 * concurrent root. Call from beforeEach; call `cleanup()` from afterEach.
 */
export function mountTestRoot(): TestRootHandle {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const container = document.createElement('div');
  document.body.appendChild(container);

  const handle: TestRootHandle = {
    container,
    root: createRoot(container),
    async render(node: ReactNode) {
      await act(async () => {
        handle.root.render(node);
      });
    },
    async cleanup() {
      await act(async () => {
        handle.root.unmount();
      });
      container.remove();
    },
  };

  return handle;
}
