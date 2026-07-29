import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeWithTimeoutCore } from './invoke-with-timeout';

/** Asserts the rejection reason, timer cleanup and the single 'rejected' settle report. */
async function expectRejectedWithSettle(
  promise: Promise<unknown>,
  failure: Error,
  onSettle: ReturnType<typeof vi.fn>,
) {
  await expect(promise).rejects.toBe(failure);
  expect(vi.getTimerCount()).toBe(0);
  expect(onSettle).toHaveBeenCalledTimes(1);
  expect(onSettle).toHaveBeenCalledWith('rejected');
}

describe('invokeWithTimeoutCore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes through a resolution before the timeout, clears the timer, and reports settle once', async () => {
    const onSettle = vi.fn();

    const promise = invokeWithTimeoutCore(() => Promise.resolve('ok'), 1000, () => new Error('unused timeout'), { onSettle });

    await expect(promise).resolves.toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onSettle).toHaveBeenCalledWith('resolved');
  });

  it('passes through a rejection before the timeout, clears the timer, and reports settle once', async () => {
    const failure = new Error('native failure');
    const onSettle = vi.fn();

    const promise = invokeWithTimeoutCore(() => Promise.reject(failure), 1000, () => new Error('unused timeout'), { onSettle });

    await expectRejectedWithSettle(promise, failure, onSettle);
  });

  it('resolves without hooks', async () => {
    await expect(invokeWithTimeoutCore(() => Promise.resolve('bare'), 1000, () => new Error('unused timeout'))).resolves.toBe('bare');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with the timeout error, hands the pending promise to onTimeout, and still reports settle when the operation resolves later', async () => {
    let resolveOperation!: (value: string) => void;
    const pendingOperation = new Promise<string>((resolve) => {
      resolveOperation = resolve;
    });
    const timeoutError = new Error('timed out');
    const onSettle = vi.fn();
    const onTimeout = vi.fn();

    const promise = invokeWithTimeoutCore(() => pendingOperation, 500, () => timeoutError, { onSettle, onTimeout });
    const assertion = expect(promise).rejects.toBe(timeoutError);

    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith(pendingOperation);
    expect(onSettle).not.toHaveBeenCalled();

    // The late resolution is dropped by the settle gate, but the settle
    // observer still fires exactly once at the moment the operation settles.
    resolveOperation('late result');
    await pendingOperation;
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onSettle).toHaveBeenCalledWith('resolved');
  });

  it('delivers the timeout error even when onTimeout itself throws', async () => {
    const timeoutError = new Error('timed out');

    const promise = invokeWithTimeoutCore(
      () => new Promise<never>(() => {}),
      250,
      () => timeoutError,
      {
        onTimeout: () => {
          throw new Error('observer exploded');
        },
      },
    );
    const assertion = expect(promise).rejects.toBe(timeoutError);

    await vi.advanceTimersByTimeAsync(250);
    await assertion;
  });

  it('never creates a timer when timeoutMs is null and passes the result through with onSettle', async () => {
    const onSettle = vi.fn();

    const promise = invokeWithTimeoutCore(() => Promise.resolve(42), null, () => new Error('unused timeout'), { onSettle });

    expect(vi.getTimerCount()).toBe(0);
    await expect(promise).resolves.toBe(42);
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onSettle).toHaveBeenCalledWith('resolved');
  });

  it('rejects with the same error when the operation throws synchronously', async () => {
    const failure = new Error('sync failure');
    const onSettle = vi.fn();

    const promise = invokeWithTimeoutCore(
      () => {
        throw failure;
      },
      1000,
      () => new Error('unused timeout'),
      { onSettle },
    );

    await expectRejectedWithSettle(promise, failure, onSettle);
  });

  it('ignores a rejection that arrives after the timeout without surfacing an unhandled rejection', async () => {
    let rejectOperation!: (error: Error) => void;
    const timeoutError = new Error('timed out');
    const onSettle = vi.fn();

    const promise = invokeWithTimeoutCore(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectOperation = reject;
        }),
      100,
      () => timeoutError,
      { onSettle },
    );
    const assertion = expect(promise).rejects.toBe(timeoutError);

    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(onSettle).not.toHaveBeenCalled();

    // Switch to real timers so Node gets genuine event-loop turns in which it
    // would report an unhandled rejection if the core left one dangling. The
    // desktop tsconfig has no Node types, so reach process via globalThis.
    vi.useRealTimers();
    type ProcessLike = {
      on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
      removeListener(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
    };
    const nodeProcess = (globalThis as { process?: ProcessLike }).process;
    expect(typeof nodeProcess?.on).toBe('function');
    const unhandled = vi.fn();
    nodeProcess?.on('unhandledRejection', unhandled);
    try {
      rejectOperation(new Error('late failure'));
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      nodeProcess?.removeListener('unhandledRejection', unhandled);
    }

    expect(unhandled).not.toHaveBeenCalled();
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onSettle).toHaveBeenCalledWith('rejected');
  });

  it('contains an onSettle observer error without affecting the caller result', async () => {
    const promise = invokeWithTimeoutCore(() => Promise.resolve('ok'), 100, () => new Error('unused timeout'), {
      onSettle: () => {
        throw new Error('settle observer exploded');
      },
    });

    await expect(promise).resolves.toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });
});
