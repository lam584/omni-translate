import i18n from '../../i18n/config';
import { activeDesktopApi } from '../desktop-api';
import { invokeWithTimeoutCore } from '../invoke-with-timeout';
import { updateNativeWatchDiagnosticGateFromIpcPing } from './watch-mode';

export const IPC_PING_TIMEOUT_MS = 750;
export const BRIDGE_INVOKE_TIMEOUT_MS = 8000;
// WebView2 can expose the Tauri JavaScript bridge before its native message
// channel is ready. Keep the startup overlay in a connecting state while the
// native side settles instead of turning a recoverable launch race into a
// permanent runtime-error snapshot.
export const IPC_PING_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000, 3000, 5000, 5000, 5000, 5000] as const;

export function invokeWithTimeout<T>(
  operation: () => Promise<T>,
  command: string,
  timeoutMs: number = BRIDGE_INVOKE_TIMEOUT_MS,
): Promise<T> {
  return invokeWithTimeoutCore(
    operation,
    timeoutMs,
    () => new Error(i18n.t('runtime.desktop.invokeTimeout', { command, timeoutMs })),
  );
}

export async function pingDesktopRuntime(): Promise<number> {
  const startedAt = performance.now();
  let lastError: unknown;

  for (let attempt = 0; attempt <= IPC_PING_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await invokeWithTimeout(
        () => activeDesktopApi().runtime.debugIpcPing(),
        'debug_ipc_ping',
        IPC_PING_TIMEOUT_MS,
      );
      updateNativeWatchDiagnosticGateFromIpcPing(response);
      return Math.round(performance.now() - startedAt);
    } catch (error) {
      lastError = error;
      const retryDelay = IPC_PING_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined) break;
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }

  throw lastError;
}
