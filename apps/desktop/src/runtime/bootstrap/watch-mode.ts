/**
 * The single watch-mode diagnostic autostart predicate. Both the App-level
 * autostart flow and the desktop bootstrap consult this; it previously
 * existed as two divergent copies (App.tsx and desktop-runtime.ts) reading
 * the same three VITE_OMNI_WATCH_MODE_* variables.
 */
export function isWatchModeDiagnosticAutostartAllowed(
  env: Record<string, string | boolean | undefined>,
  nowMs = Date.now(),
) {
  if (env.VITE_OMNI_WATCH_MODE_AUTOSTART !== '1') {
    return false;
  }
  const runMarker = env.VITE_OMNI_WATCH_MODE_RUN_MARKER;
  if (typeof runMarker !== 'string' || !runMarker.startsWith('watch_mode_diagnostic.run_id=')) {
    return false;
  }
  const expiresAtMs = Number(env.VITE_OMNI_WATCH_MODE_EXPIRES_AT_MS);
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
}

let nativeWatchDiagnosticAutostartAuthoritative = false;

/**
 * Vite variables are frozen into a production bundle at build time. The live
 * runner, however, selects its model and run marker when the desktop process is
 * launched. Cache the native process truth returned by the first successful IPC
 * ping so generic renderer startup tasks cannot race the backend-owned Watch
 * diagnostic with a stale persisted config.
 */
export function updateNativeWatchDiagnosticGateFromIpcPing(response: string) {
  const watchDiagnostic = /(?:^|\s)watchDiagnostic=true(?:\s|$)/.test(response);
  const backendAuthoritative = /(?:^|\s)backendAutostartAuthoritative=true(?:\s|$)/.test(response);
  nativeWatchDiagnosticAutostartAuthoritative = watchDiagnostic && backendAuthoritative;
  return nativeWatchDiagnosticAutostartAuthoritative;
}

export function isNativeWatchDiagnosticAutostartAuthoritative() {
  return nativeWatchDiagnosticAutostartAuthoritative;
}

export function shouldSuppressGenericStartupAutostart(
  env: Record<string, string | boolean | undefined>,
  nowMs = Date.now(),
) {
  return nativeWatchDiagnosticAutostartAuthoritative
    || isWatchModeDiagnosticAutostartAllowed(env, nowMs);
}

/** Test seam: each renderer process normally sets this only through IPC ping. */
export function resetNativeWatchDiagnosticGateForTests() {
  nativeWatchDiagnosticAutostartAuthoritative = false;
}
