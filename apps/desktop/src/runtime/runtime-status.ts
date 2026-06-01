import type { RuntimeBridgeStatus, RuntimeSnapshot } from '../schema/runtime-core';
import { isTauriRuntime } from './tauri-runtime';

export function resolveRuntimeBridgeStatus(snapshot: RuntimeSnapshot): RuntimeBridgeStatus {
  if (snapshot.bridgeStatus === 'runtime-error') {
    return 'runtime-error';
  }

  if (isTauriRuntime()) {
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