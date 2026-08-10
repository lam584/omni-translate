import i18n from '../../i18n/config';
import type { AppConfigDraft } from '../../schema/config';
import type { RuntimeSnapshot } from '../../schema/runtime-core';
import { useAppStore } from '../../stores/app-store';
import { bridgeCaptureRouteMatches, bridgeProcessIsRunning } from '../../utils/bridge-capture-route';
import { resolveProcessLoopbackCapability } from '../../utils/process-loopback-capability';
import { activeDesktopApi } from '../desktop-api';
import { invokeWithTimeout } from './invoke';
import { pushDesktopRuntimeNotification } from './notifications';
import { scheduleStartupTask } from './schedule';
import { shouldSuppressGenericStartupAutostart } from './watch-mode';

export const BRIDGE_AUTOSTART_AFTER_READY_DELAY_MS = 0;
const BRIDGE_STARTUP_REFRESH_TIMEOUT_MS = 3000;
const BRIDGE_STARTUP_START_TIMEOUT_MS = 8000;

type RuntimeCleanup = () => void;

function shouldAutostartBridge(snapshot: RuntimeSnapshot, config: AppConfigDraft) {
  const processExclusionSelected = config.devices.feedbackLoopPrevention === 'process-exclusion';
  const processLoopback = resolveProcessLoopbackCapability(snapshot.bridge);
  const captureRouteMismatch = !bridgeCaptureRouteMatches(
    snapshot.bridge,
    config.devices.feedbackLoopPrevention,
  );
  return (
    snapshot.bridgeStatus === 'tauri-shell' &&
    (processExclusionSelected || snapshot.bridge.driverHealth === 'running') &&
    (!processExclusionSelected || !['unsupported', 'failed'].includes(processLoopback.status)) &&
    (!bridgeProcessIsRunning(snapshot.bridge) || captureRouteMismatch)
  );
}

function assertAutostartCaptureRoute(snapshot: RuntimeSnapshot, config: AppConfigDraft) {
  if (!bridgeProcessIsRunning(snapshot.bridge)
    || !bridgeCaptureRouteMatches(snapshot.bridge, config.devices.feedbackLoopPrevention)) {
    throw new Error(
      `Bridge autostart capture backend did not converge: requested=${config.devices.feedbackLoopPrevention} `
      + `actual=${snapshot.bridge.sourceCaptureMode}/${snapshot.bridge.captureBackend}`,
    );
  }
}

async function refreshAndAutostartBridgeStartup(config: AppConfigDraft) {
  try {
    const processExclusionSelected = config.devices.feedbackLoopPrevention === 'process-exclusion';
    if (processExclusionSelected) {
      // Process loopback owns neither the virtual driver nor its health probe.
      // Use the bootstrap snapshot only to verify that we are in the desktop
      // shell, then let start_bridge_service activate/probe process loopback.
      // Calling bridge.refresh here would run the legacy driver probe first.
      const currentSnapshot = useAppStore.getState().runtimeSnapshot;
      if (shouldSuppressGenericStartupAutostart(import.meta.env) || !shouldAutostartBridge(currentSnapshot, config)) {
        return;
      }
      const startedSnapshot = await invokeWithTimeout(
        () => activeDesktopApi().legacyBridge.start(config),
        'start_bridge_service',
        BRIDGE_STARTUP_START_TIMEOUT_MS,
      );
      assertAutostartCaptureRoute(startedSnapshot, config);
      useAppStore.getState().setRuntimeSnapshot(startedSnapshot);
      return;
    }

    const driverSnapshot = await invokeWithTimeout(
      () => activeDesktopApi().bridge.refresh(),
      'bridge_v2.refresh',
      BRIDGE_STARTUP_REFRESH_TIMEOUT_MS,
    );
    useAppStore.getState().setRuntimeSnapshot(driverSnapshot);

    if (shouldSuppressGenericStartupAutostart(import.meta.env) || !shouldAutostartBridge(driverSnapshot, config)) {
      return;
    }

    const startedSnapshot = await invokeWithTimeout(
      () => activeDesktopApi().legacyBridge.start(config),
      'start_bridge_service',
      BRIDGE_STARTUP_START_TIMEOUT_MS,
    );
    assertAutostartCaptureRoute(startedSnapshot, config);
    useAppStore.getState().setRuntimeSnapshot(startedSnapshot);
  } catch (error) {
    pushDesktopRuntimeNotification(
      'warning',
      'bridge-autostart-failed',
      i18n.t('runtime.desktop.bridgeAutostartFailed', { error: error instanceof Error ? error.message : String(error) }),
    );
  }
}

export function scheduleBridgeAutostartAfterStartup(
  config: AppConfigDraft = useAppStore.getState().configDraft,
  delayMs = BRIDGE_AUTOSTART_AFTER_READY_DELAY_MS,
): { cleanup: RuntimeCleanup; promise: Promise<void> } {
  return scheduleStartupTask(() => refreshAndAutostartBridgeStartup(config), delayMs);
}
