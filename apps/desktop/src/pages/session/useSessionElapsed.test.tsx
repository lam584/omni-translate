import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { registerDomHarness } from '../../test-utils/component-test-harness';
import { parseRuntimeTimestampMs, useSessionElapsed } from './useSessionElapsed';

describe('useSessionElapsed', () => {
  let elapsed = -1;

  function Harness({ startedAt, running }: { startedAt: string | null; running: boolean }) {
    elapsed = useSessionElapsed(startedAt, running);
    return null;
  }

  const view = registerDomHarness({
    fakeTimers: true,
    setup: () => {
      vi.setSystemTime(new Date('2026-07-25T00:00:10.000Z'));
    },
  });

  it('updates a running session and clears its interval when stopped', async () => {
    const startedAt = Date.now() - 5_000;
    await view.render(<Harness startedAt={`unix-ms:${startedAt}`} running />);
    expect(elapsed).toBe(5);

    await act(async () => {
      vi.setSystemTime(Date.now() + 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(elapsed).toBe(7);

    await act(async () => {
      view.root.render(<Harness startedAt={`unix-ms:${startedAt}`} running={false} />);
      await Promise.resolve();
    });
    expect(elapsed).toBe(0);
  });

  it('handles seconds, ISO, invalid, future, and missing timestamps', () => {
    expect(parseRuntimeTimestampMs('unix:123')).toBe(123_000);
    expect(parseRuntimeTimestampMs('2026-07-25T00:00:00.000Z')).toBe(Date.parse('2026-07-25T00:00:00.000Z'));
    expect(parseRuntimeTimestampMs('invalid')).toBeNull();
    expect(parseRuntimeTimestampMs(null)).toBeNull();
  });
});
