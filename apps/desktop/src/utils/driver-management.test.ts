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
});
