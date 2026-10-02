import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableTauriDesktopRuntime } from '../test-utils/runtime-test-harness';
import { invokeMock } from '../test-utils/tauri-invoke-mock';
import { createLogger, getRecentFrontendLogEntries, installGlobalErrorCapture, loggerTestHelpers } from './logger';
vi.mock('@tauri-apps/api/core', async () => (await import('../test-utils/tauri-invoke-mock')).tauriCoreMockModule());

describe('logger flush concurrency and global-event boundaries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    enableTauriDesktopRuntime();
    invokeMock.mockReset().mockResolvedValue(undefined);
    loggerTestHelpers.reset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => { loggerTestHelpers.reset(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('ignores an empty flush and prevents parallel IPC from duplicating a pending batch', async () => {
    await loggerTestHelpers.flushNow();
    expect(invokeMock).not.toHaveBeenCalled();
    let complete!: () => void;
    invokeMock.mockReturnValue(new Promise<void>((resolve) => { complete = resolve; }));
    createLogger('runtime').info('one entry');
    const first = loggerTestHelpers.flushNow();
    await loggerTestHelpers.flushNow();
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(loggerTestHelpers.pendingCount()).toBe(1);
    complete();
    await first;
    expect(loggerTestHelpers.pendingCount()).toBe(0);
  });

  it('does not install global error handlers without a window', () => {
    const listen = vi.spyOn(window, 'addEventListener');
    vi.stubGlobal('window', undefined);
    expect(() => installGlobalErrorCapture()).not.toThrow();
    expect(listen).not.toHaveBeenCalled();
  });

  it('records missing error locations and non-Error rejection reasons without losing their diagnostics', () => {
    // Capture handlers rather than dispatching to jsdom, which treats an
    // uncaught ErrorEvent as a test-runner failure even when it is observed.
    const listen = vi.spyOn(window, 'addEventListener').mockImplementation(() => undefined);
    installGlobalErrorCapture();
    const errorHandler = listen.mock.calls.find(([name]) => name === 'error')![1] as (event: Partial<ErrorEvent>) => void;
    const rejectHandler = listen.mock.calls.find(([name]) => name === 'unhandledrejection')![1] as unknown as (event: { reason: unknown }) => void;
    errorHandler({ message: 'no source', filename: '' });
    errorHandler({ message: 'no coordinates', filename: 'renderer.js' });
    rejectHandler({ reason: 'socket closed' });
    expect(getRecentFrontendLogEntries().map((entry) => entry.detail)).toEqual([
      'message=no source source=-', 'message=no coordinates source=renderer.js:0:0', 'reason=socket closed',
    ]);
    expect(getRecentFrontendLogEntries().every((entry) => entry.level === 'error')).toBe(true);
  });
});
