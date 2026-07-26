// Deliberately dependency-free so vi.mock factories can import this module
// without pulling the wider test-utils import graph into the mock scope.

export interface ReactI18nextStubOptions {
  /**
   * true  -> t(key, { defaultValue }) returns defaultValue ?? key
   * false -> t(key) returns the key itself (default)
   */
  passthroughDefault?: boolean;
}

/**
 * Returns a module object suitable for a vi.mock('react-i18next', ...)
 * factory. Because vi.mock factories are hoisted and must not close over
 * file-level variables, use it via a dynamic import inside the factory:
 *
 *   vi.mock('react-i18next', async () =>
 *     (await import('../test-utils/i18n-stub')).reactI18nextStub({ passthroughDefault: true }));
 */
export function reactI18nextStub(options: ReactI18nextStubOptions = {}) {
  const t = options.passthroughDefault
    ? (key: string, callOptions?: { defaultValue?: string }) => callOptions?.defaultValue ?? key
    : (key: string) => key;

  return {
    useTranslation: () => ({ t }),
  };
}
