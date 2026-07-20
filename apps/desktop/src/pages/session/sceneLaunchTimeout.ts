import type { SceneMode } from '../../utils/scene-readiness';

const SCENE_LAUNCH_TIMEOUT_MS = 900;

export function sceneLaunchTimeoutMs(mode: SceneMode, isOmniModel: boolean) {
  void mode;
  void isOmniModel;
  return SCENE_LAUNCH_TIMEOUT_MS;
}
