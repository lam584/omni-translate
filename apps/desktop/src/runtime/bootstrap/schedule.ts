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
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  const run = () => void Promise.resolve(task()).finally(() => resolvePromise?.());
  const timer = delayMs <= 0 ? null : setTimeout(run, delayMs);
  if (timer === null) {
    run();
  }

  return {
    cleanup: () => {
      if (timer !== null) clearTimeout(timer);
    },
    promise,
  };
}
