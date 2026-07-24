export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  delayMs: number,
): {
  (...args: Args): void;
  cancel: () => void;
  flush: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: Args | null = null;

  const wrapped = ((...args: Args) => {
    pendingArgs = args;
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      const current = pendingArgs;
      pendingArgs = null;
      // A live timer is only created after pendingArgs is assigned. Cancellation
      // clears both atomically, so the timer callback always owns arguments.
      fn(...current!);
    }, delayMs);
  }) as {
    (...args: Args): void;
    cancel: () => void;
    flush: () => void;
  };

  wrapped.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pendingArgs = null;
  };

  wrapped.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const current = pendingArgs;
    pendingArgs = null;
    if (current) {
      fn(...current);
    }
  };

  return wrapped;
}
