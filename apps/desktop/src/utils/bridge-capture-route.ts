import type { FeedbackLoopPrevention } from '../schema/config';
import type { RuntimeSnapshot } from '../schema/runtime-core';

type BridgeCaptureRoute = Pick<RuntimeSnapshot['bridge'], 'sourceCaptureMode' | 'captureBackend'>;

export function expectedBridgeCaptureRoute(feedbackMode: FeedbackLoopPrevention): BridgeCaptureRoute {
  if (feedbackMode === 'process-exclusion') {
    return { sourceCaptureMode: 'process-exclusion', captureBackend: 'wasapi-process-exclusion' };
  }
  if (feedbackMode === 'virtual-driver') {
    return { sourceCaptureMode: 'virtual-driver', captureBackend: 'driver-virtual-speaker' };
  }
  return { sourceCaptureMode: 'none', captureBackend: 'none' };
}

export function bridgeCaptureRouteMatches(
  bridge: RuntimeSnapshot['bridge'],
  feedbackMode: FeedbackLoopPrevention,
): boolean {
  const expected = expectedBridgeCaptureRoute(feedbackMode);
  return bridge.sourceCaptureMode === expected.sourceCaptureMode
    && bridge.captureBackend === expected.captureBackend;
}

export function bridgeProcessIsRunning(bridge: RuntimeSnapshot['bridge']): boolean {
  return bridge.processStatus === 'running' && bridge.bridgeState === 'running';
}
