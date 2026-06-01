import { isTauri } from '@tauri-apps/api/core';

type TauriInternalsWindow = Window & {
  __TAURI_INTERNALS__?: {
    invoke?: unknown;
  };
};

export function hasInvokeBridge() {
  if (typeof window === 'undefined') {
    return false;
  }

  return typeof (window as TauriInternalsWindow).__TAURI_INTERNALS__?.invoke === 'function';
}

export function isTauriRuntime() {
  return typeof window !== 'undefined' && (isTauri() || hasInvokeBridge());
}

export async function waitForTauriRuntime(timeoutMs = 800, intervalMs = 25): Promise<boolean> {
  if (isTauriRuntime()) {
    return true;
  }

  if (typeof window === 'undefined') {
    return false;
  }

  const startedAt = Date.now();

  return await new Promise<boolean>((resolve) => {
    const tick = () => {
      if (isTauriRuntime()) {
        resolve(true);
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        resolve(false);
        return;
      }

      window.setTimeout(tick, intervalMs);
    };

    tick();
  });
}