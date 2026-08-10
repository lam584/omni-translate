import type { FeedbackLoopPrevention } from '../../schema/config';
import type { SceneMode } from '../../utils/scene-readiness';

const SCENE_LAUNCH_TIMEOUT_MS = 900;
const PROCESS_EXCLUSION_LAUNCH_TIMEOUT_MS = 8_000;

/**
 * Returns the scene launch timeout in milliseconds. Process exclusion gets a
 * cold-Bridge budget; prewarmed routes keep the sub-second readiness budget.
 */
export function sceneLaunchTimeoutMs(
  _mode: SceneMode,
  feedbackLoopPrevention?: FeedbackLoopPrevention,
): number {
  return feedbackLoopPrevention === 'process-exclusion'
    ? PROCESS_EXCLUSION_LAUNCH_TIMEOUT_MS
    : SCENE_LAUNCH_TIMEOUT_MS;
}
