import { vi } from 'vitest';

/**
 * Shared spies for the hoisted `vi.mock('.../runtime/bridge-runtime')`
 * factories used by the driver-management suites. Mirrors the pattern in
 * `tauri-invoke-mock.ts`: this module only depends on vitest so the mock
 * factory can `await import(...)` it without pulling app modules into the
 * factory's dependency graph.
 *
 * Usage in a test file:
 *
 *   vi.mock('../runtime/bridge-runtime', async () =>
 *     (await import('../test-utils/driver-runtime-mock')).bridgeRuntimeMockModule());
 *   import { driverRuntimeMocks } from '../test-utils/driver-runtime-mock';
 */
export const driverRuntimeMocks = {
  installDriverRuntime: vi.fn(),
  repairDriverRuntime: vi.fn(),
  uninstallDriverRuntime: vi.fn(),
  refreshBridgeRuntime: vi.fn(),
  startBridgeServiceRuntime: vi.fn(),
};

/** Module factory for `vi.mock('.../runtime/bridge-runtime', ...)`. */
export function bridgeRuntimeMockModule() {
  return {
    installDriverRuntime: (...args: unknown[]) => driverRuntimeMocks.installDriverRuntime(...args),
    repairDriverRuntime: (...args: unknown[]) => driverRuntimeMocks.repairDriverRuntime(...args),
    uninstallDriverRuntime: (...args: unknown[]) => driverRuntimeMocks.uninstallDriverRuntime(...args),
    refreshBridgeRuntime: (...args: unknown[]) => driverRuntimeMocks.refreshBridgeRuntime(...args),
    startBridgeServiceRuntime: (...args: unknown[]) => driverRuntimeMocks.startBridgeServiceRuntime(...args),
  };
}

/** Call from beforeEach to clear implementations and recorded calls. */
export function resetDriverRuntimeMocks() {
  for (const mock of Object.values(driverRuntimeMocks)) {
    mock.mockReset();
  }
}
