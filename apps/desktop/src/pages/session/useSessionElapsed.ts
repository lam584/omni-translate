import { useEffect, useRef, useState } from 'react';

import { parseRuntimeTimestampMs } from '../../utils/runtime-timestamp';

export { parseRuntimeTimestampMs };

export function useSessionElapsed(sessionStartedAt: string | null, isSessionRunning: boolean): number {
  const [elapsed, setElapsed] = useState(() => resolveElapsed(sessionStartedAt, isSessionRunning));
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const updateElapsed = () => setElapsed(resolveElapsed(sessionStartedAt, isSessionRunning));
    if (isSessionRunning) {
      updateElapsed();
      timerRef.current ??= setInterval(updateElapsed, 1_000);
    } else {
      // React runs the previous effect cleanup before this branch, so any live
      // interval has already been cleared.
      queueMicrotask(() => setElapsed(0));
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isSessionRunning, sessionStartedAt]);

  return elapsed;
}

function resolveElapsed(sessionStartedAt: string | null, isSessionRunning: boolean): number {
  if (!isSessionRunning) return 0;
  const startedAtMs = parseRuntimeTimestampMs(sessionStartedAt);
  if (startedAtMs === null || startedAtMs <= 0) return 0;
  return Math.max(0, Math.floor((Date.now() - startedAtMs) / 1_000));
}
