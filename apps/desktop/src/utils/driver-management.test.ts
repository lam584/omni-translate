import { describe, expect, it } from 'vitest';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import { resolveRecommendedDriverAction } from './driver-management';

describe('resolveRecommendedDriverAction', () => {
  it('maps real driver states to stable UI actions', () => {
    const bridge = structuredClone(runtimeSnapshotMock.bridge);
    expect(resolveRecommendedDriverAction(bridge)).toBe('install');
    bridge.driverHealth = 'damaged';
    expect(resolveRecommendedDriverAction(bridge)).toBe('reinstall');
    bridge.driverHealth = 'running';
    expect(resolveRecommendedDriverAction(bridge)).toBe('start-bridge');
    bridge.bridgeState = 'running';
    expect(resolveRecommendedDriverAction(bridge)).toBe('refresh');
  });

  it('treats device evidence as an installed driver when bridge reports stale missing-driver state', () => {
    const bridge = structuredClone(runtimeSnapshotMock.bridge);
    bridge.driverHealth = 'not-installed';
    bridge.bridgeState = 'degraded';
    bridge.lastErrorCode = 'driver.not-installed';
    bridge.rootDeviceCount = 1;
    bridge.rootInstanceIds = ['ROOT\\MEDIA\\0000'];
    bridge.endpointName = 'Speakers (Omni Translate Virtual Speaker)';
    bridge.abiVersion = '0x20260604';
    bridge.ioctlAvailable = true;

    expect(resolveRecommendedDriverAction(bridge)).toBe('start-bridge');
  });
});
