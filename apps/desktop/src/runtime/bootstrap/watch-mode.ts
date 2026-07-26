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
