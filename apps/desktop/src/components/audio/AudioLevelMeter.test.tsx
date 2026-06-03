import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AudioLevelMeter from './AudioLevelMeter';

describe('AudioLevelMeter', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  async function render(energyDb: number, vadState: string, captureActive?: boolean) {
    await act(async () => {
      root.render(
        <AudioLevelMeter
          captureActive={captureActive}
          energyDb={energyDb}
          label="input"
          vadState={vadState}
        />,
      );
    });
  }

  it('renders silence, speech, held peaks and peak expiry', async () => {
    await render(-90, 'silence');
    expect(container.textContent).toContain('静音');

    await render(-10.588235294117647, 'speech');
    expect(container.textContent).toContain('语音');
    expect(container.querySelectorAll('.audio-level-meter-bar-active').length).toBeGreaterThan(0);

    await render(-90, 'silence');
    expect(container.querySelectorAll('.audio-level-meter-bar-peak').length).toBeGreaterThan(0);

    await render(-1, 'speech');
    await render(-90, 'silence');
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(container.querySelectorAll('.audio-level-meter-bar-peak')).toHaveLength(0);
  });

  it('omits the active class by default and applies it when captureActive is true', async () => {
    await render(-30, 'speech');
    expect(container.querySelector('.audio-level-meter')?.classList.contains('audio-level-meter-active')).toBe(false);

    await render(-30, 'speech', true);
    expect(container.querySelector('.audio-level-meter')?.classList.contains('audio-level-meter-active')).toBe(true);

    await render(-30, 'speech', false);
    expect(container.querySelector('.audio-level-meter')?.classList.contains('audio-level-meter-active')).toBe(false);
  });
});
