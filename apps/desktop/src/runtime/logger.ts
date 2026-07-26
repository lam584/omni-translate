/* eslint-disable no-console -- this module is the single sanctioned console
   mirror; every other file must log through createLogger instead. */
import { desktopApiV2 } from './desktop-api-v2';
import { isTauriRuntime } from './tauri-runtime';

export type FrontendLogLevel = 'debug' | 'info' | 'warning' | 'error';

export type FrontendLogEntry = {
  category: string;
  level: FrontendLogLevel;
  summary: string;
  detail: string | null;
  emittedAt: string;
};

export type FrontendLogger = {
  debug(summary: string, detail?: string): void;
  info(summary: string, detail?: string): void;
  warn(summary: string, detail?: string): void;
  error(summary: string, detail?: string): void;
};

/** In-memory ring of recent entries, readable by tests and debug tooling. */
const RING_CAPACITY = 500;
/** Pending (not yet forwarded) entries; overflow drops the oldest + counts. */
const PENDING_CAPACITY = 500;
/** Forward as soon as this many entries are pending… */
const BATCH_SIZE = 20;
/** …or this long after the first pending entry, whichever comes first. */
const BATCH_INTERVAL_MS = 2000;
/** Exponential backoff bounds for failed forwards (1s → 2s → … → 30s). */
const RETRY_INITIAL_MS = 1000;
const RETRY_MAX_MS = 30000;
/** Upper bound of entries per IPC call while catching up after a retry. */
const MAX_BATCH_PER_INVOKE = 100;

const state = {
  ring: [] as FrontendLogEntry[],
  pending: [] as FrontendLogEntry[],
  droppedCount: 0,
  flushTimer: null as ReturnType<typeof setTimeout> | null,
  flushTargetAt: 0,
  backoffUntil: 0,
  retryDelayMs: RETRY_INITIAL_MS,
  flushInFlight: false,
};

function mirrorToConsole(entry: FrontendLogEntry): void {
  const prefix = `[omni][${entry.category}]`;
  const parts = entry.detail === null ? [prefix, entry.summary] : [prefix, entry.summary, entry.detail];
  if (entry.level === 'error') {
    console.error(...parts);
  } else if (entry.level === 'warning') {
    console.warn(...parts);
  } else if (entry.level === 'info') {
    console.info(...parts);
  } else {
    console.debug(...parts);
  }
}

function scheduleFlush(delayMs: number): void {
  const now = Date.now();
  const targetAt = now + Math.max(delayMs, state.backoffUntil - now, 0);
  if (state.flushTimer !== null) {
    if (targetAt >= state.flushTargetAt) {
      return;
    }
    clearTimeout(state.flushTimer);
  }
  state.flushTargetAt = targetAt;
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    void flushPending();
  }, targetAt - now);
}

async function flushPending(): Promise<void> {
  if (state.flushInFlight) {
    return;
  }
  if (state.pending.length === 0 && state.droppedCount === 0) {
    return;
  }
  if (!isTauriRuntime()) {
    // Browser preview: entries only live in the console mirror + ring.
    state.pending = [];
    state.droppedCount = 0;
    return;
  }

  state.flushInFlight = true;
  const batch = state.pending.slice(0, MAX_BATCH_PER_INVOKE);
  const dropped = state.droppedCount;
  try {
    await desktopApiV2.diagnostics.appendLogs(batch, dropped);
    state.pending.splice(0, batch.length);
    state.droppedCount -= dropped;
    state.retryDelayMs = RETRY_INITIAL_MS;
    state.backoffUntil = 0;
    state.flushInFlight = false;
    if (state.pending.length > 0 || state.droppedCount > 0) {
      scheduleFlush(0);
    }
  } catch {
    // Keep the batch in the pending buffer and back off exponentially; the
    // entries are re-sent once the IPC channel recovers.
    state.flushInFlight = false;
    state.backoffUntil = Date.now() + state.retryDelayMs;
    state.retryDelayMs = Math.min(state.retryDelayMs * 2, RETRY_MAX_MS);
    scheduleFlush(0);
  }
}

function append(category: string, level: FrontendLogLevel, summary: string, detail?: string): void {
  const entry: FrontendLogEntry = {
    category,
    level,
    summary,
    detail: detail ?? null,
    emittedAt: new Date().toISOString(),
  };

  mirrorToConsole(entry);

  state.ring.push(entry);
  if (state.ring.length > RING_CAPACITY) {
    state.ring.shift();
  }

  if (state.pending.length >= PENDING_CAPACITY) {
    state.pending.shift();
    state.droppedCount += 1;
  }
  state.pending.push(entry);
  // Urgent bypass: errors must reach disk before a potential crash, and the
  // `startup.*` readiness markers are timing evidence parsed from app.log
  // line timestamps (measure-startup-readiness.ps1) — batching them would
  // inflate the measured readiness by up to BATCH_INTERVAL_MS.
  const urgent = level === 'error' || summary.startsWith('startup.');
  scheduleFlush(urgent || state.pending.length >= BATCH_SIZE ? 0 : BATCH_INTERVAL_MS);
}

/**
 * Category-scoped frontend logger: mirrors to the devtools console, records
 * into a bounded in-memory ring, and forwards to the native diagnostics log
 * in batches of {@link BATCH_SIZE} (or every {@link BATCH_INTERVAL_MS}), with
 * bounded buffering and exponential-backoff retry when IPC is unavailable.
 */
export function createLogger(category: string): FrontendLogger {
  return {
    debug: (summary, detail) => append(category, 'debug', summary, detail),
    info: (summary, detail) => append(category, 'info', summary, detail),
    warn: (summary, detail) => append(category, 'warning', summary, detail),
    error: (summary, detail) => append(category, 'error', summary, detail),
  };
}

/** Recent entries seen by any logger, oldest first. */
export function getRecentFrontendLogEntries(): readonly FrontendLogEntry[] {
  return state.ring;
}

/**
 * Wire `window.onerror` + `unhandledrejection` into the runtime logger so
 * renderer crashes reach app.log. Call once from the application entrypoint.
 */
export function installGlobalErrorCapture(): void {
  if (typeof window === 'undefined') {
    return;
  }
  const logger = createLogger('runtime');
  window.addEventListener('error', (event) => {
    const location = event.filename ? `${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0}` : '-';
    logger.error('window.onerror captured an uncaught error', `message=${event.message} source=${location}`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = (event as { reason?: unknown }).reason;
    const detail = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
    logger.error('unhandledrejection captured an unhandled promise rejection', `reason=${detail}`);
  });
}

/** Test hooks for vitest; production code must not reach into these. */
export const loggerTestHelpers = {
  flushNow: flushPending,
  pendingCount: () => state.pending.length,
  droppedCount: () => state.droppedCount,
  reset(): void {
    if (state.flushTimer !== null) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    state.ring = [];
    state.pending = [];
    state.droppedCount = 0;
    state.flushTargetAt = 0;
    state.backoffUntil = 0;
    state.retryDelayMs = RETRY_INITIAL_MS;
    state.flushInFlight = false;
  },
};
