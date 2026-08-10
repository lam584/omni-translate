import type { RuntimeSnapshot } from '../schema/runtime-core';

export type ProcessLoopbackStatus = RuntimeSnapshot['bridge']['processLoopbackStatus'];
export type SourceCaptureMode = RuntimeSnapshot['bridge']['sourceCaptureMode'];

export type ProcessLoopbackCapability = {
  supported: boolean;
  status: ProcessLoopbackStatus;
  windowsBuildNumber: number | null;
  minimumWindowsBuild: number;
  failureDetail: string | null;
  sourceCaptureMode: SourceCaptureMode;
  captureBackend: RuntimeSnapshot['bridge']['captureBackend'];
  excludedProcessId: number | null;
  sourceMonitorPlaybackEnabled: boolean;
  translationPlaybackEnabled: boolean;
};

/**
 * Gives UI/readiness/diagnostics one normalized view of the generated bridge
 * fields. Protocol-version mismatches are rejected by the bridge boundary, so
 * this helper deliberately does not fabricate compatibility with an old shell.
 */
export function resolveProcessLoopbackCapability(
  bridge: RuntimeSnapshot['bridge'],
): ProcessLoopbackCapability {
  const failureDetail = bridge.processLoopbackFailureDetail?.trim().length
    ? bridge.processLoopbackFailureDetail.trim()
    : null;

  return {
    supported: bridge.processLoopbackSupported,
    status: bridge.processLoopbackStatus,
    windowsBuildNumber: bridge.windowsBuildNumber,
    minimumWindowsBuild: bridge.processLoopbackMinimumWindowsBuild,
    failureDetail,
    sourceCaptureMode: bridge.sourceCaptureMode,
    captureBackend: bridge.captureBackend,
    excludedProcessId: bridge.excludedProcessId,
    sourceMonitorPlaybackEnabled: bridge.sourceMonitorPlaybackEnabled,
    translationPlaybackEnabled: bridge.translationPlaybackEnabled,
  };
}

export function isProcessLoopbackReady(capability: ProcessLoopbackCapability): boolean {
  return capability.supported && capability.status === 'ready';
}

export function isProcessLoopbackSelectable(capability: ProcessLoopbackCapability): boolean {
  // `unknown` is the cold-start state before Bridge has been launched. It must
  // remain selectable so choosing this route can start Bridge and run the
  // capability probe. Explicit terminal failures are the only disabled states.
  return !['unsupported', 'failed'].includes(capability.status);
}
