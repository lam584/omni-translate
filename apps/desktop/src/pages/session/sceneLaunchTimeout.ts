import type { SceneMode } from '../../utils/scene-readiness';

const SCENE_LAUNCH_TIMEOUT_MS = 900;

/**
 * Returns the scene launch timeout in milliseconds.
 * Parameters are reserved for future per-mode/per-model tuning.
 */
export function sceneLaunchTimeoutMs(_mode: SceneMode): number {
  return SCENE_LAUNCH_TIMEOUT_MS;
}
