import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LogLevelControl } from './LogLevelControl';

const setLogLevel = vi.fn();

vi.mock('../../runtime/desktop-api-context', () => ({
  useDesktopApiV2: () => ({ diagnostics: { setLogLevel } }),
}));

describe('LogLevelControl', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    setLogLevel.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('rolls back a failed selection, shows the cause, and retries it', async () => {
    setLogLevel.mockRejectedValueOnce(new Error('runtime offline')).mockResolvedValueOnce(undefined);
    await act(async () => root.render(<LogLevelControl />));
    const select = container.querySelector('select')!;
    await act(async () => {
      select.value = 'debug';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(select.value).toBe('');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('runtime offline');
    await act(async () => container.querySelector<HTMLButtonElement>('[role="alert"] button')?.click());
    expect(setLogLevel).toHaveBeenNthCalledWith(2, 'debug');
    expect(select.value).toBe('debug');
  });
});
