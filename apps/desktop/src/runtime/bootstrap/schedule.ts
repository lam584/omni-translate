type RuntimeCleanup = () => void;

// Shared "run once after the startup idle delay" scaffold used by bridge
// autostart and capture pre-warm: fire the task after `delayMs` (immediately
// when the delay is zero or negative), resolve `promise` once the task
// settles, and expose a cleanup that cancels a still-pending timer.
export function scheduleStartupTask(
  task: () => void | Promise<void>,
  delayMs: number,
): { cleanup: RuntimeCleanup; promise: Promise<void> } {
  let resolvePromise: (() => void) | undefined;
  let settled = false;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  const settle = () => {
    if (settled) return;
    settled = true;
    resolvePromise?.();
  };
  // Start from an already-resolved promise so both a synchronous throw and an
  // asynchronous rejection are observed. Startup work is best-effort; callers
  // report its product-facing error themselves, so the scheduler consumes the
  // failure and exposes a completion-only promise without an unhandled rejection.
  const run = () => {
    void Promise.resolve().then(task).then(settle, settle);
  };
  const timer = delayMs <= 0 ? null : setTimeout(run, delayMs);
  if (timer === null) {
    run();
  }

  return {
    cleanup: () => {
      if (timer !== null) clearTimeout(timer);
      settle();
    },
    promise,
  };
}
