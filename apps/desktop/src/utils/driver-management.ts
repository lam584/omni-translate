import type { RuntimeSnapshot } from '../schema/runtime-core';

export type DriverManagementAction = 'install' | 'uninstall' | 'reinstall' | 'start-bridge' | 'refresh';

export function resolveRecommendedDriverAction(bridge: RuntimeSnapshot['bridge']): DriverManagementAction {
  if (bridge.driverHealth === 'not-installed') return 'install';
  if (bridge.driverHealth === 'damaged' || bridge.driverHealth === 'version-mismatch') return 'reinstall';
  if (bridge.bridgeState !== 'running') return 'start-bridge';
  return 'refresh';
}
