/**
 * Shared timeout primitive for the renderer's invoke wrappers.
 *
 * The five runtime modules (desktop-runtime, audio-runtime, bridge-runtime,
 * provider-runtime, benchmark-runtime) each grew their own copy of the same
 * race: start the native invoke, arm a timer, and let a `settled` gate ensure
 * exactly one outcome wins. This module is the common base they migrate onto.
 * It owns only the mechanics: eager invocation, the single-settle gate, timer
 * cleanup, and keeping a late rejection of the underlying operation from ever
 * surfacing as an unhandled rejection.
 *
 * Everything module-specific stays with the callers: i18n timeout messages
 * (via `makeTimeoutError`), trace/diagnostics logging, decorated error fields
 * (`code`/`operation`/`retriable`/`suggestion`), timeout floors such as the
 * provider minimum clamp, and compensation work such as audio's
 * `recoverAfterTimeout` (via `hooks.onTimeout`).
 */

export type InvokeTimeoutHooks<T> = {
  /** Called exactly once when the underlying operation settles (either outcome), even if the caller already timed out. */
  onSettle?: (outcome: 'resolved' | 'rejected') => void;
  /** Called when the timeout fires, with the still-pending operation promise (used e.g. by audio's recoverAfterTimeout compensation). Must not affect the timeout rejection. */
  onTimeout?: (pending: Promise<T>) => void;
};

function notifySettle<T>(hooks: InvokeTimeoutHooks<T> | undefined, outcome: 'resolved' | 'rejected') {
  try {
    hooks?.onSettle?.(outcome);
  } catch {
    // Detached observer: there is no consumer its failure could propagate to,
    // and it must never turn into an unhandled rejection. Callers log inside
    // their own hook if they care.
  }
}

export function invokeWithTimeoutCore<T>(
  operation: () => Promise<T>,
  timeoutMs: number | null,
  makeTimeoutError: () => Error,
  hooks?: InvokeTimeoutHooks<T>,
): Promise<T> {
  let pending: Promise<T>;
  try {
    // Invoke eagerly, before any race is set up, so the operation is always
    // started exactly once and its promise can be handed to `onTimeout`.
    pending = operation();
  } catch (error) {
    // A synchronous throw is an already-failed operation: surface it as a
    // rejection of the returned promise instead of throwing at the call site.
    pending = Promise.reject(error);
  }

  // Detached observer: fires onSettle at the moment the operation truly
  // settles (including after a caller-visible timeout) and keeps `pending`
  // handled, so a rejection arriving after the timeout already rejected the
  // returned promise never surfaces as an unhandled rejection.
  void pending.then(
    () => notifySettle(hooks, 'resolved'),
    () => notifySettle(hooks, 'rejected'),
  );

  if (timeoutMs === null) {
    return pending;
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(makeTimeoutError());
      if (hooks?.onTimeout) {
        try {
          hooks.onTimeout(pending);
        } catch {
          // The timeout rejection above already happened; a failing observer
          // must not mask or alter it.
        }
      }
    }, timeoutMs);

    pending.then(
      (result) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
