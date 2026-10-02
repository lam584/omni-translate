import { describe, expect, it } from 'vitest';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import { resolveDriverDiagnosis } from './driver-diagnostics';

describe('legacy install evidence without a health projection', () => {
  it.each([{ endpointName: 'Omni virtual mic' }, { abiVersion: '1' }, { ioctlAvailable: true }])('retains installation evidence %j instead of reporting notInstalled', (evidence) => {
    const bridge: typeof runtimeSnapshotMock.bridge = { ...structuredClone(runtimeSnapshotMock.bridge), driverHealth: 'not-installed' as const, driverProbeState: 'idle' as const, bridgeState: 'stopped' as const, lastErrorCode: null, driverDetail: null, lastDriverOperation: null, rootDeviceCount: 0, endpointName: null, abiVersion: null, ioctlAvailable: false, ...evidence };
    expect(resolveDriverDiagnosis(bridge)).toMatchObject({ key: 'bridgeStopped', tone: 'warning' });
    bridge.bridgeState = 'running';
    expect(resolveDriverDiagnosis(bridge)).toMatchObject({ key: 'ready', tone: 'success' });
  });
});
