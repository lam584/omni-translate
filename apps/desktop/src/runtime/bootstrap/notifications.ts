import type { RuntimeNotification } from '../../schema/runtime-core';
import { useAppStore } from '../../stores/app-store';

// Shared by the bootstrap modules: push a desktop-runtime notification with a
// timestamped id so repeated pushes of the same prefix never collide.
export function pushDesktopRuntimeNotification(level: RuntimeNotification['level'], idPrefix: string, message: string) {
  useAppStore.getState().pushRuntimeNotification({
    id: `${idPrefix}-${Date.now()}`,
    level,
    source: 'desktop-runtime',
    message,
    emittedAt: new Date().toISOString(),
  });
}
