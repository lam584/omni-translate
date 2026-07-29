import { vi } from 'vitest';

/**
 * Shared spies for the hoisted `vi.mock('@tauri-apps/api/...')` factories.
 * Test files and the mocked plugin modules resolve the same module instance
 * (vitest isolates the registry per test file), so assertions observe the
 * exact spy the runtime code calls into.
 *
 * Usage in a test file:
 *
 *   vi.mock('@tauri-apps/api/core', async () =>
 *     (await import('../test-utils/tauri-invoke-mock')).tauriCoreMockModule());
 *   import { invokeMock } from '../test-utils/tauri-invoke-mock';
 */
export const invokeMock = vi.fn();
export const emitMock = vi.fn();
export const listenMock = vi.fn();

/** Module factory for `vi.mock('@tauri-apps/api/core', ...)` outside the Tauri shell. */
export function tauriCoreMockModule() {
  return {
    invoke: (...args: unknown[]) => invokeMock(...args),
    isTauri: () => false,
  };
}

/** Same as {@link tauriCoreMockModule}, but `isTauri` honours `globalThis.isTauri`. */
export function tauriCoreMockModuleWithRuntimeFlag() {
  return {
    invoke: (...args: unknown[]) => invokeMock(...args),
    isTauri: () => Boolean((globalThis as typeof globalThis & { isTauri?: boolean }).isTauri),
  };
}

/** Module factory for `vi.mock('@tauri-apps/api/event', ...)`. */
export function tauriEventMockModule() {
  return {
    emit: (...args: unknown[]) => emitMock(...args),
    listen: (...args: unknown[]) => listenMock(...args),
  };
}

/** Redirects listenMock to capture handlers into the returned map, keyed by event name. */
export function captureRegisteredListeners() {
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  listenMock.mockImplementation(async (eventName: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(eventName, handler);
    return () => listeners.delete(eventName);
  });
  return listeners;
}
