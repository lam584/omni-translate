import type { RuntimeSnapshot } from '../schema/runtime-core';
import { resolveRecommendedDriverAction, type DriverManagementAction } from './driver-management';

export type DriverDiagnosisKey =
  | 'testSigningDisabled'
  | 'secureBootEnabled'
  | 'memoryIntegrityEnabled'
  | 'rebootRequired'
  | 'audioProbeFailed'
  | 'bridgeDegraded'
  | 'operationFailed'
  | 'notInstalled'
  | 'needsRepair'
  | 'bridgeStopped'
  | 'ready';

export type DriverDiagnosisTone = 'success' | 'warning' | 'error';

export type DriverDiagnosis = {
  key: DriverDiagnosisKey;
  tone: DriverDiagnosisTone;
  recommendedAction: DriverManagementAction;
  reason: string | null;
};

function bridgeDiagnosticText(bridge: RuntimeSnapshot['bridge']) {
  return [bridge.lastErrorCode, bridge.driverDetail, bridge.lastDriverOperation?.summary].filter(Boolean).join('\n');
}

function firstDiagnosticLine(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}

export function resolveDriverDiagnosis(bridge: RuntimeSnapshot['bridge']): DriverDiagnosis {
  const diagnosticText = bridgeDiagnosticText(bridge);
  const reason = firstDiagnosticLine(diagnosticText);
  const recommendedAction = resolveRecommendedDriverAction(bridge);
  const ready = bridge.driverHealth === 'running' && bridge.bridgeState === 'running' && !bridge.lastErrorCode;

  if (bridge.lastErrorCode === 'driver.memory-integrity-enabled') {
    return { key: 'memoryIntegrityEnabled', tone: 'error', recommendedAction, reason };
  }
  if (bridge.lastErrorCode === 'driver.testsigning-disabled') {
    return { key: 'testSigningDisabled', tone: 'error', recommendedAction, reason };
  }
  if (bridge.lastErrorCode === 'driver.secure-boot-enabled') {
    return { key: 'secureBootEnabled', tone: 'error', recommendedAction, reason };
  }
  if (bridge.driverProbeState === 'failed') {
    return { key: 'operationFailed', tone: 'error', recommendedAction, reason: reason ?? 'Driver probe failed; installation state could not be verified.' };
  }
  if (ready) {
    return { key: 'ready', tone: 'success', recommendedAction, reason };
  }
  if (bridge.lastErrorCode === 'driver.reboot-required' || diagnosticText.includes('CM_PROB_FAILED_START')) {
    return { key: 'rebootRequired', tone: 'error', recommendedAction, reason };
  }
  if (bridge.lastErrorCode === 'driver.audio-probe-failed' || diagnosticText.includes('WASAPI audio probe failed')) {
    return { key: 'audioProbeFailed', tone: 'error', recommendedAction, reason };
  }
  if (bridge.bridgeState === 'degraded' || bridge.lastErrorCode === 'bridge.timeout') {
    return { key: 'bridgeDegraded', tone: 'error', recommendedAction, reason };
  }
  if (bridge.lastErrorCode === 'driver.operation-failed') {
    return { key: 'operationFailed', tone: 'error', recommendedAction, reason };
  }
  if (bridge.driverHealth === 'not-installed') {
    return { key: 'notInstalled', tone: 'warning', recommendedAction, reason };
  }
  if (bridge.driverHealth === 'damaged' || bridge.driverHealth === 'version-mismatch') {
    return { key: 'needsRepair', tone: 'error', recommendedAction, reason };
  }
  if (bridge.bridgeState !== 'running') {
    return { key: 'bridgeStopped', tone: 'warning', recommendedAction, reason };
  }
  return { key: 'ready', tone: 'success', recommendedAction, reason };
}
