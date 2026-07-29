import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { registerDomHarness } from '../../test-utils/component-test-harness';
import { LogLevelControl } from './LogLevelControl';

const setLogLevel = vi.fn();

vi.mock('../../runtime/desktop-api-context', () => ({
  useDesktopApiV2: () => ({ diagnostics: { setLogLevel } }),
}));

describe('LogLevelControl', () => {
  const view = registerDomHarness({
    setup: () => {
      setLogLevel.mockReset();
    },
  });

  it('rolls back a failed selection, shows the cause, and retries it', async () => {
    setLogLevel.mockRejectedValueOnce(new Error('runtime offline')).mockResolvedValueOnce(undefined);
    await view.render(<LogLevelControl />);
    const select = view.container.querySelector('select')!;
    await act(async () => {
      select.value = 'debug';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(select.value).toBe('');
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('runtime offline');
    await act(async () => view.container.querySelector<HTMLButtonElement>('[role="alert"] button')?.click());
    expect(setLogLevel).toHaveBeenNthCalledWith(2, 'debug');
    expect(select.value).toBe('debug');
  });
});
