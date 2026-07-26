import { activeDesktopApi } from '../desktop-api';
import { createLogger } from '../logger';

const runtimeLogger = createLogger('runtime');

export type BootstrapStepId =
  | 'detect-runtime'
  | 'check-ipc'
  | 'init-runtime'
  | 'init-audio'
  | 'load-config';

export type BootstrapStepStatus = 'active' | 'done' | 'error';

export type OnBootstrapStep = (stepId: BootstrapStepId, status: BootstrapStepStatus, detail?: string) => void;

// Native-log forwarding is only safe once the IPC channel has been proven ready
// by a successful `debug_ipc_ping`. Firing an extra `invoke` *before* the ping
// (e.g. for the detect-runtime step) races the WebView2 native message channel
// while it is still settling and was observed to wedge the very first invoke,
// stalling startup before the ping. We therefore stay silent until the ping
// succeeds; the steps that matter for backend observability (init-runtime,
// load-config, init-audio) all occur after that point anyway.
let nativeLogForwardingEnabled = false;

export function enableNativeLogForwarding() {
  nativeLogForwardingEnabled = true;
}

/** Test seam: restore the pre-ping silent state between suites. */
export function resetNativeLogForwardingForTests() {
  nativeLogForwardingEnabled = false;
}

// Mirror every bootstrap step transition into the native diagnostics log so the
// Rust-side app.log and the diagnostics page reflect the *frontend* startup
// state, not just the backend's. Previously the renderer owned the entire
// startup handshake and the backend log went dark after the IPC ping, which is
// exactly why a stalled `bootstrap_runtime` was invisible from the logs. This is
// fire-and-forget: it uses a trivial sync command (like `debug_ipc_ping`) and
// never blocks or throws, so it works even while a heavier invoke is stuck.
function forwardStepToNativeLog(stepId: BootstrapStepId, status: BootstrapStepStatus, detail?: string) {
  if (!activeDesktopApi().capabilities.hasNativeShell || !nativeLogForwardingEnabled) {
    return;
  }
  // Routed through the unified logger: `startup.*` summaries take its urgent
  // path, so step transitions keep the immediate, best-effort forwarding this
  // helper always had while gaining buffering + retry once IPC is proven.
  const summary = `startup.step ${stepId}=${status}`;
  if (status === 'error') {
    runtimeLogger.error(summary, detail);
  } else if (status === 'active') {
    runtimeLogger.debug(summary, detail);
  } else {
    runtimeLogger.info(summary, detail);
  }
}

export function markStep(onStep: OnBootstrapStep | undefined, stepId: BootstrapStepId, status: BootstrapStepStatus, detail?: string) {
  onStep?.(stepId, status, detail);
  forwardStepToNativeLog(stepId, status, detail);
}
