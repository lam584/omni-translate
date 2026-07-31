import i18n from '../../i18n/config';
import type { AppConfigDraft } from '../../schema/config';
import type { RuntimeSnapshot } from '../../schema/runtime-core';
import { useAppStore } from '../../stores/app-store';
import { activeDesktopApi } from '../desktop-api';
import { invokeWithTimeout } from './invoke';
import { pushDesktopRuntimeNotification } from './notifications';
import { scheduleStartupTask } from './schedule';
import { shouldSuppressGenericStartupAutostart } from './watch-mode';

export const BRIDGE_AUTOSTART_AFTER_READY_DELAY_MS = 0;
const BRIDGE_STARTUP_REFRESH_TIMEOUT_MS = 3000;
const BRIDGE_STARTUP_START_TIMEOUT_MS = 8000;

type RuntimeCleanup = () => void;

function shouldAutostartBridge(snapshot: RuntimeSnapshot) {
  return (
    snapshot.bridgeStatus === 'tauri-shell' &&
    snapshot.bridge.driverHealth === 'running' &&
    (snapshot.bridge.processStatus === 'stopped' || snapshot.bridge.processStatus === 'error')
  );
}

async function refreshAndAutostartBridgeStartup(config: AppConfigDraft) {
  try {
    const driverSnapshot = await invokeWithTimeout(
      () => activeDesktopApi().bridge.refresh(),
      'bridge_v2.refresh',
      BRIDGE_STARTUP_REFRESH_TIMEOUT_MS,
    );
    useAppStore.getState().setRuntimeSnapshot(driverSnapshot);

    if (shouldSuppressGenericStartupAutostart(import.meta.env) || !shouldAutostartBridge(driverSnapshot)) {
      return;
    }

    const startedSnapshot = await invokeWithTimeout(
      () => activeDesktopApi().legacyBridge.start(config),
      'start_bridge_service',
      BRIDGE_STARTUP_START_TIMEOUT_MS,
    );
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
