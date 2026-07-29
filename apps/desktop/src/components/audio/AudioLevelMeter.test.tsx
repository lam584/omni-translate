import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { registerDomHarness } from '../../test-utils/component-test-harness';
import AudioLevelMeter from './AudioLevelMeter';

describe('AudioLevelMeter', () => {
  const view = registerDomHarness({ fakeTimers: true });

  async function render(energyDb: number, vadState: string, captureActive?: boolean) {
    await view.render(
      <AudioLevelMeter
        captureActive={captureActive}
        energyDb={energyDb}
        label="input"
        vadState={vadState}
      />,
    );
  }

  it('renders silence, speech, held peaks and peak expiry', async () => {
    await render(-90, 'silence');
    expect(view.container.textContent).toContain('静音');

    await render(-10.588235294117647, 'speech');
    expect(view.container.textContent).toContain('语音');
    expect(view.container.querySelectorAll('.audio-level-meter-bar-active').length).toBeGreaterThan(0);

    await render(-90, 'silence');
    expect(view.container.querySelectorAll('.audio-level-meter-bar-peak').length).toBeGreaterThan(0);

    await render(-1, 'speech');
    await render(-90, 'silence');
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(view.container.querySelectorAll('.audio-level-meter-bar-peak')).toHaveLength(0);
  });

  it('omits the active class by default and applies it when captureActive is true', async () => {
    await render(-30, 'speech');
    expect(view.container.querySelector('.audio-level-meter')?.classList.contains('audio-level-meter-active')).toBe(false);

    await render(-30, 'speech', true);
    expect(view.container.querySelector('.audio-level-meter')?.classList.contains('audio-level-meter-active')).toBe(true);

    await render(-30, 'speech', false);
    expect(view.container.querySelector('.audio-level-meter')?.classList.contains('audio-level-meter-active')).toBe(false);
  });
});
