import type { RuntimeSnapshot } from '../schema/runtime-core';

export type DriverManagementAction = 'install' | 'uninstall' | 'reinstall' | 'start-bridge' | 'refresh';

export function hasInstalledDriverEvidence(bridge: RuntimeSnapshot['bridge']) {
  return bridge.rootDeviceCount > 0 || Boolean(bridge.endpointName) || Boolean(bridge.abiVersion) || bridge.ioctlAvailable;
}

export function resolveRecommendedDriverAction(bridge: RuntimeSnapshot['bridge']): DriverManagementAction {
  if (bridge.driverHealth === 'not-installed' && !hasInstalledDriverEvidence(bridge)) return 'install';
  if (bridge.driverHealth === 'damaged' || bridge.driverHealth === 'version-mismatch') return 'reinstall';
  if (bridge.bridgeState !== 'running') return 'start-bridge';
  return 'refresh';
}
