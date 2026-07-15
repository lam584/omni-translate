import { useEffect, useRef, useState } from 'react';

export function parseRuntimeTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = value.startsWith('unix-ms:')
    ? value.slice('unix-ms:'.length)
    : value.startsWith('unix:') ? value.slice('unix:'.length) : value;
  const numeric = Number(normalized);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function useSessionElapsed(sessionStartedAt: string | null, isSessionRunning: boolean): number {
  const [elapsed, setElapsed] = useState(() => resolveElapsed(sessionStartedAt, isSessionRunning));
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const updateElapsed = () => setElapsed(resolveElapsed(sessionStartedAt, isSessionRunning));
    if (isSessionRunning) {
      updateElapsed();
      timerRef.current ??= setInterval(updateElapsed, 1_000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
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
  return startedAtMs === null ? 0 : Math.max(0, Math.floor((Date.now() - startedAtMs) / 1_000));
}
