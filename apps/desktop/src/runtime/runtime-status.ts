import type { RuntimeBridgeStatus, RuntimeSnapshot } from '../schema/runtime-core';
import { activeDesktopApi } from './desktop-api';

export function resolveRuntimeBridgeStatus(snapshot: RuntimeSnapshot): RuntimeBridgeStatus {
  if (snapshot.bridgeStatus === 'runtime-error') {
    return 'runtime-error';
  }

  if (activeDesktopApi().capabilities.hasNativeShell) {
    return 'tauri-shell';
  }

  if (
    snapshot.bridgeStatus === 'tauri-shell' ||
    snapshot.storage.status === 'ready' ||
    snapshot.activeProfileId === 'desktop-shell' ||
    snapshot.notifications.some((notification) => notification.source === 'rust-core')
  ) {
    return 'tauri-shell';
  }

  return 'browser-preview';
}