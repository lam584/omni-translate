import { describe, expect, it } from 'vitest';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import { resolveDriverDiagnosis } from './driver-diagnostics';

function bridgePatch(patch: Partial<typeof runtimeSnapshotMock.bridge>) {
  return {
    ...structuredClone(runtimeSnapshotMock.bridge),
    ...patch,
  };
}

describe('resolveDriverDiagnosis', () => {
  it('prioritizes explicit platform blockers', () => {
    expect(resolveDriverDiagnosis(bridgePatch({ lastErrorCode: 'driver.secure-boot-enabled' })).key).toBe('secureBootEnabled');
    expect(resolveDriverDiagnosis(bridgePatch({ lastErrorCode: 'driver.testsigning-disabled' })).key).toBe('testSigningDisabled');
    expect(resolveDriverDiagnosis(bridgePatch({ lastErrorCode: 'driver.memory-integrity-enabled' })).key).toBe('memoryIntegrityEnabled');
  });

  it('maps reboot-required signals from error codes and PnP details', () => {
    expect(resolveDriverDiagnosis(bridgePatch({ lastErrorCode: 'driver.reboot-required' })).key).toBe('rebootRequired');
    expect(
      resolveDriverDiagnosis(
        bridgePatch({
          lastErrorCode: null,
          driverDetail: 'Root\\OmniTranslateVirtualSpeaker is present but not running. Problem=CM_PROB_FAILED_START',
        }),
      ).key,
    ).toBe('rebootRequired');
  });

  it('maps WASAPI audio probe summaries without a last error code', () => {
    const diagnosis = resolveDriverDiagnosis(
      bridgePatch({
        driverHealth: 'running',
        bridgeState: 'degraded',
        lastErrorCode: null,
        driverDetail:
          'driver.operation-failed: The WASAPI audio probe failed. ExitCode=1 Detail=idle peak 0.499969 exceeds 0.002000',
      }),
    );

    expect(diagnosis.key).toBe('audioProbeFailed');
    expect(diagnosis.tone).toBe('error');
    expect(diagnosis.reason).toContain('WASAPI audio probe failed');
  });

  it('maps degraded bridge and generic operation failures', () => {
    expect(
      resolveDriverDiagnosis(
        bridgePatch({
          driverHealth: 'running',
          bridgeState: 'degraded',
          lastErrorCode: null,
          driverDetail: null,
        }),
      ).key,
    ).toBe('bridgeDegraded');
    expect(resolveDriverDiagnosis(bridgePatch({ lastErrorCode: 'driver.operation-failed' })).key).toBe('operationFailed');
  });

  it('keeps base driver and bridge states stable', () => {
    expect(resolveDriverDiagnosis(bridgePatch({ driverHealth: 'not-installed', bridgeState: 'stopped', lastErrorCode: null })).key).toBe(
      'notInstalled',
    );
    expect(resolveDriverDiagnosis(bridgePatch({ driverHealth: 'damaged', bridgeState: 'stopped', lastErrorCode: null })).key).toBe(
      'needsRepair',
    );
    expect(resolveDriverDiagnosis(bridgePatch({ driverHealth: 'running', bridgeState: 'stopped', lastErrorCode: null })).key).toBe(
      'bridgeStopped',
    );
    expect(resolveDriverDiagnosis(bridgePatch({ driverHealth: 'running', bridgeState: 'running', lastErrorCode: null })).key).toBe('ready');
  });

  it('does not let stale operation summaries override a clean ready state', () => {
    expect(
      resolveDriverDiagnosis(
        bridgePatch({
          driverHealth: 'running',
          bridgeState: 'running',
          lastErrorCode: null,
          lastDriverOperation: {
            schemaVersion: 1,
            operationId: 'old-operation',
            action: 'install',
            succeeded: false,
            phase: 'failed',
            errorCode: 'driver.audio-probe-failed',
            summary: 'The WASAPI audio probe failed.',
            logPath: 'C:\\old.log',
            startedAt: '2026-06-01T00:00:00Z',
            finishedAt: '2026-06-01T00:00:01Z',
          },
        }),
      ).key,
    ).toBe('ready');
  });
});
