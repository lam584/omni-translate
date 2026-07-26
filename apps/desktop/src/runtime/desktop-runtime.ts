/**
 * Desktop startup orchestration facade.
 *
 * The implementation lives in `./bootstrap/*` (steps, invoke plumbing,
 * bridge autostart, capture pre-warm, config fallback, core connect, startup
 * state machine and the concurrent-flight shell); this module only re-exports
 * the public surface its four importers use, so their import paths stay
 * stable while every implementation file sits inside the coverage include.
 */
export {
  BRIDGE_AUTOSTART_AFTER_READY_DELAY_MS,
  scheduleBridgeAutostartAfterStartup,
} from './bootstrap/bridge-autostart';
export {
  CAPTURE_PREWARM_AFTER_READY_DELAY_MS,
  scheduleCapturePrewarmAfterStartup,
} from './bootstrap/capture-prewarm';
export { CONFIG_DRAFT_SYNC_EVENT } from './bootstrap/connect';
export { bootstrapDesktopRuntimeBridge } from './bootstrap/flight';
export {
  enableNativeLogForwarding,
  type BootstrapStepId,
  type BootstrapStepStatus,
  type OnBootstrapStep,
} from './bootstrap/steps';

import { canUseLocalStorage, writeConfigDraftShadow } from './bootstrap/config-fallback';
import { connectTestHelpers } from './bootstrap/connect';

/** Test hooks for vitest; production code must not reach into these. */
export const desktopRuntimeTestHelpers = {
  canUseLocalStorage,
  writeConfigDraftShadow,
  invokeWithTimeout: connectTestHelpers.invokeWithTimeout,
  createRuntimeErrorSnapshot: connectTestHelpers.createRuntimeErrorSnapshot,
  connectDesktopRuntimeBridge: connectTestHelpers.connectDesktopRuntimeBridge,
};
