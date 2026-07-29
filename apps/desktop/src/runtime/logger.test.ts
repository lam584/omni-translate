import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () => (await import('../test-utils/tauri-invoke-mock')).tauriCoreMockModule());

import { invokeMock } from '../test-utils/tauri-invoke-mock';
import { enablePreviewDesktopRuntime, enableTauriDesktopRuntime } from '../test-utils/runtime-test-harness';
import {
  createLogger,
  getRecentFrontendLogEntries,
  installGlobalErrorCapture,
  loggerTestHelpers,
} from './logger';

function batchPayload(callIndex: number) {
  return invokeMock.mock.calls[callIndex]?.[1] as {
    entries: Array<{ category: string; level: string; summary: string; detail: string | null }>;
    droppedCount: number;
  };
}

describe('frontend logger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset().mockResolvedValue(undefined);
    enableTauriDesktopRuntime();
    loggerTestHelpers.reset();
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    loggerTestHelpers.reset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('flushes immediately once the batch size of 20 is reached', async () => {
    const logger = createLogger('runtime');
    for (let index = 0; index < 20; index += 1) {
      logger.info(`line ${index}`);
    }
    await vi.advanceTimersByTimeAsync(0);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0]?.[0]).toBe('append_frontend_diagnostics_logs');
    expect(batchPayload(0).entries).toHaveLength(20);
    expect(batchPayload(0).droppedCount).toBe(0);
    expect(loggerTestHelpers.pendingCount()).toBe(0);
  });

  it('flushes smaller batches after the 2 second interval', async () => {
    const logger = createLogger('audio');
    logger.info('single line');

    await vi.advanceTimersByTimeAsync(1999);
    expect(invokeMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(batchPayload(0).entries[0]).toMatchObject({
      category: 'audio',
      level: 'info',
      summary: 'single line',
      detail: null,
    });
  });

  it('retries with exponential backoff and resends buffered entries after recovery', async () => {
    invokeMock.mockRejectedValue(new Error('ipc down'));
    const logger = createLogger('runtime');
    logger.error('must survive');

    // Error entries take the urgent path: first attempt at t=0.
    await vi.advanceTimersByTimeAsync(0);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(loggerTestHelpers.pendingCount()).toBe(1);

    // First retry after 1s.
    await vi.advanceTimersByTimeAsync(1000);
    expect(invokeMock).toHaveBeenCalledTimes(2);

    // Second retry doubles the delay to 2s.
    await vi.advanceTimersByTimeAsync(1999);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(invokeMock).toHaveBeenCalledTimes(3);

    // Recovery: the buffered entry is re-sent, nothing was lost.
    invokeMock.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(4000);
    expect(loggerTestHelpers.pendingCount()).toBe(0);
    const lastPayload = batchPayload(invokeMock.mock.calls.length - 1);
    expect(lastPayload.entries[0]).toMatchObject({ summary: 'must survive' });
  });

  it('drops the oldest entries beyond the pending capacity and reports the count once', async () => {
    const logger = createLogger('runtime');
    for (let index = 0; index < 505; index += 1) {
      logger.info(`line ${index}`);
    }
    expect(loggerTestHelpers.pendingCount()).toBe(500);
    expect(loggerTestHelpers.droppedCount()).toBe(5);

    await vi.runAllTimersAsync();

    expect(loggerTestHelpers.pendingCount()).toBe(0);
    expect(loggerTestHelpers.droppedCount()).toBe(0);
    expect(batchPayload(0).droppedCount).toBe(5);
    // The oldest five entries were dropped, so forwarding starts at line 5.
    expect(batchPayload(0).entries[0]?.summary).toBe('line 5');
    const forwarded = invokeMock.mock.calls.reduce(
      (total, _call, index) => total + batchPayload(index).entries.length,
      0,
    );
    expect(forwarded).toBe(500);
  });

  it('keeps only the most recent 500 entries in the ring buffer', () => {
    enablePreviewDesktopRuntime();
    const logger = createLogger('runtime');
    for (let index = 0; index < 510; index += 1) {
      logger.info(`entry ${index}`);
    }
    const ring = getRecentFrontendLogEntries();
    expect(ring).toHaveLength(500);
    expect(ring[0]?.summary).toBe('entry 10');
    expect(ring.at(-1)?.summary).toBe('entry 509');
  });

  it('never invokes IPC outside the Tauri runtime', async () => {
    enablePreviewDesktopRuntime();
    const logger = createLogger('runtime');
    logger.error('browser only');
    await vi.runAllTimersAsync();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(getRecentFrontendLogEntries().map((entry) => entry.summary)).toContain('browser only');
  });

  it('captures window errors and unhandled promise rejections', () => {
    enablePreviewDesktopRuntime();
    installGlobalErrorCapture();

    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', filename: 'app.js', lineno: 1, colno: 2 }));
    const rejectionEvent = new Event('unhandledrejection') as Event & { reason?: unknown };
    rejectionEvent.reason = new Error('lost promise');
    window.dispatchEvent(rejectionEvent);

    const entries = getRecentFrontendLogEntries();
    const errorEntry = entries.find((entry) => entry.summary === 'window.onerror captured an uncaught error');
    expect(errorEntry).toMatchObject({ level: 'error', category: 'runtime' });
    expect(errorEntry?.detail).toContain('message=boom');
    const rejectionEntry = entries.find(
      (entry) => entry.summary === 'unhandledrejection captured an unhandled promise rejection',
    );
    expect(rejectionEntry?.detail).toContain('lost promise');
  });
});
