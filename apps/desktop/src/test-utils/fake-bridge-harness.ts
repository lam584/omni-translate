/**
 * Mutable invoke slots shared between test files and the hoisted
 * `vi.mock('@tauri-apps/api/core')` factory. This module intentionally has no
 * imports: the mock factory `await import(...)`s it, so pulling app modules in
 * here would re-enter the mocked tauri module during factory evaluation.
 *
 * Usage in a test file:
 *
 *   vi.mock('@tauri-apps/api/core', async () =>
 *     (await import('../test-utils/fake-bridge-harness')).fakeBridgeTauriCoreModule());
 *   import { connectFakeBridge, disconnectFakeBridge } from '../test-utils/fake-bridge-harness';
 */
export const fakeBridgeHarness = {
  invoke: null as null | (<T>(command: string, args?: Record<string, unknown>) => Promise<T>),
  /** When set, this command hangs so tests can observe pending UI states. */
  holdCommand: null as null | { command: string; promise: Promise<unknown> },
};

/** Module factory for `vi.mock('@tauri-apps/api/core', ...)` backed by a fake bridge. */
export function fakeBridgeTauriCoreModule() {
  return {
    invoke: <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (fakeBridgeHarness.holdCommand?.command === command) return fakeBridgeHarness.holdCommand.promise as Promise<T>;
      if (!fakeBridgeHarness.invoke) return Promise.reject(new Error(`fake bridge not installed for command ${command}`));
      return fakeBridgeHarness.invoke(command, args);
    },
    isTauri: () => true,
  };
}

/** Routes the mocked tauri invoke onto a fresh fake bridge (call in beforeEach). */
export function connectFakeBridge(invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>) {
  fakeBridgeHarness.invoke = invoke;
  fakeBridgeHarness.holdCommand = null;
}

/** Detaches the fake bridge so late invokes fail loudly (call in afterEach). */
export function disconnectFakeBridge() {
  fakeBridgeHarness.invoke = null;
  fakeBridgeHarness.holdCommand = null;
}
