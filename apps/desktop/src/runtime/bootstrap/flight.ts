import { runBootstrapDesktopRuntimeBridge } from './startup';
import type { BootstrapStepId, BootstrapStepStatus, OnBootstrapStep } from './steps';

type RuntimeCleanup = () => void;

type BootstrapStepSnapshot = {
  stepId: BootstrapStepId;
  status: BootstrapStepStatus;
  detail?: string;
};

type BootstrapFlight = {
  consumers: number;
  listeners: Set<OnBootstrapStep>;
  emittedSteps: BootstrapStepSnapshot[];
  cleanup: RuntimeCleanup | null;
  // Assigned synchronously right after the flight is registered; consumers
  // can only observe it afterwards.
  promise: Promise<RuntimeCleanup> | null;
};

let activeBootstrapFlight: BootstrapFlight | null = null;

export async function bootstrapDesktopRuntimeBridge(onStep?: OnBootstrapStep): Promise<RuntimeCleanup> {
  if (activeBootstrapFlight) {
    const flight = activeBootstrapFlight;
    flight.consumers += 1;
    if (onStep) {
      flight.listeners.add(onStep);
      // 晚订阅者立即回放已发出的步骤快照，避免只收未来步骤而漏掉终态。
      for (const snapshot of flight.emittedSteps) {
        onStep(snapshot.stepId, snapshot.status, snapshot.detail);
      }
    }

    await flight.promise;

    return () => {
      if (onStep) {
        flight.listeners.delete(onStep);
      }
      flight.consumers -= 1;
      if (flight.consumers <= 0) {
        // The flight settles before release closures exist (the await below),
        // so the cleanup is always present here and the active slot was
        // already cleared by then/catch.
        (flight.cleanup as RuntimeCleanup)();
      }
    };
  }

  const listeners = new Set<OnBootstrapStep>();
  if (onStep) {
    listeners.add(onStep);
  }

  const flight: BootstrapFlight = {
    consumers: 1,
    listeners,
    emittedSteps: [],
    cleanup: null,
    promise: null,
  };
  activeBootstrapFlight = flight;

  const broadcastStep: OnBootstrapStep = (stepId, status, detail) => {
    // 记录快照，供晚订阅者加入时回放，保证其也能收齐终态。
    flight.emittedSteps.push({ stepId, status, detail });
    for (const listener of Array.from(flight.listeners)) {
      listener(stepId, status, detail);
    }
  };

  flight.promise = runBootstrapDesktopRuntimeBridge(broadcastStep)
    .then((cleanup) => {
      flight.cleanup = cleanup;
      // Settles before any caller resumes, so this flight is still the
      // registered one (mirrors the catch below).
      activeBootstrapFlight = null;
      return cleanup;
    })
    .catch((error) => {
      // The catch runs at settle time, before any caller code resumes, so
      // this flight is still the registered one.
      activeBootstrapFlight = null;
      throw error;
    });

  await flight.promise;

  return () => {
    if (onStep) {
      flight.listeners.delete(onStep);
    }
    flight.consumers -= 1;
    if (flight.consumers <= 0) {
      // Settled by construction (see await above), so only the cleanup call
      // remains for the last consumer.
      (flight.cleanup as RuntimeCleanup)();
    }
  };
}
