import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAudioDeviceTestController } from './useAudioDeviceTestController';

type Controller = ReturnType<typeof useAudioDeviceTestController>;

describe('useAudioDeviceTestController', () => {
  let container: HTMLDivElement;
  let root: Root;
  let controller: Controller;

  function Harness() {
    controller = useAudioDeviceTestController((kind) => `${kind} passed`, 'selected-microphone');
    return null;
  }

  async function mount() {
    await act(async () => {
      root.render(<Harness />);
    });
  }

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await act(async () => root.unmount());
    container.remove();
  });

  it('reports unsupported microphone capture', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    await mount();

    await act(async () => controller.testMicrophone());

    expect(controller.microphone).toMatchObject({ testing: false, energyDb: -90 });
    expect(controller.microphone.result).toBe('当前桌面运行时不支持麦克风测试');
  });

  it('reports a non-Error microphone IPC/browser failure', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockRejectedValue('permission denied') },
    });
    await mount();

    await act(async () => controller.testMicrophone());

    expect(controller.microphone.result).toBe('permission denied');
  });

  it('tests the selected microphone, samples audible energy, and releases resources', async () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn();
    const analyser = {
      fftSize: 0,
      getFloatTimeDomainData: vi.fn((samples: Float32Array) => samples.fill(0.01)),
    };
    const context = {
      createAnalyser: vi.fn(() => analyser),
      createMediaStreamSource: vi.fn(() => ({ connect })),
      close,
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }) },
    });
    vi.stubGlobal('AudioContext', vi.fn(function AudioContextMock() { return context; }));
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(901);
    await mount();

    await act(async () => {
      const test = controller.testMicrophone();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(50);
      await test;
    });

    expect(analyser.fftSize).toBe(1024);
    expect(connect).toHaveBeenCalledWith(analyser);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { exact: 'selected-microphone' } },
    });
    expect(controller.microphone.testing).toBe(false);
    expect(controller.microphone.result).toContain('microphone passed');
    expect(controller.microphone.result).toContain('-40.0 dB');
    expect(controller.microphone.energyDb).toBeCloseTo(-40);
    expect(stop).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it('classifies microphone permission, disconnect, and exclusive-use failures', async () => {
    const getUserMedia = vi.fn()
      .mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
      .mockRejectedValueOnce(new DOMException('gone', 'NotFoundError'))
      .mockRejectedValueOnce(new DOMException('busy', 'NotReadableError'));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    await mount();
    await act(async () => controller.testMicrophone());
    expect(controller.microphone.result).toContain('权限');
    await act(async () => controller.testMicrophone());
    expect(controller.microphone.result).toContain('断开');
    await act(async () => controller.testMicrophone());
    expect(controller.microphone.result).toContain('独占');
  });

  it('reports a no-signal failure instead of a false pass', async () => {
    vi.useFakeTimers();
    const analyser = { fftSize: 0, getFloatTimeDomainData: vi.fn((samples: Float32Array) => samples.fill(0)) };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
    });
    vi.stubGlobal('AudioContext', vi.fn(function AudioContextMock() {
      return {
        createAnalyser: () => analyser,
        createMediaStreamSource: () => ({ connect: () => undefined }),
        close: vi.fn().mockResolvedValue(undefined),
      };
    }));
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(901);
    await mount();
    await act(async () => {
      const test = controller.testMicrophone();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(50);
      await test;
    });
    expect(controller.microphone.result).not.toContain('microphone passed');
    expect(controller.microphone.result).toContain('-90.0 dB');
  });

  it('plays the speaker tone and publishes a passed result after the ended event', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const gain = { gain: { value: 0 }, connect: vi.fn() };
    gain.connect.mockReturnValue(gain);
    const oscillator = {
      frequency: { value: 0 },
      connect: vi.fn(() => gain),
      start: vi.fn(),
      stop: vi.fn(),
      addEventListener: vi.fn((_name: string, listener: EventListenerOrEventListenerObject) => {
        if (typeof listener === 'function') listener(new Event('ended'));
      }),
    };
    const context = {
      currentTime: 2,
      destination: {},
      createOscillator: vi.fn(() => oscillator),
      createGain: vi.fn(() => gain),
      close,
    };
    vi.stubGlobal('AudioContext', vi.fn(function AudioContextMock() { return context; }));
    await mount();

    await act(async () => controller.testSpeaker());

    expect(oscillator.frequency.value).toBe(660);
    expect(gain.gain.value).toBe(0.08);
    expect(oscillator.stop).toHaveBeenCalledWith(2.9);
    expect(controller.speaker).toEqual({ testing: false, result: 'speaker passed', energyDb: -90 });
    expect(close).toHaveBeenCalled();
  });

  it('reports speaker construction failures and tolerates an empty thrown value', async () => {
    vi.stubGlobal('AudioContext', vi.fn(function AudioContextMock() { throw ''; }));
    await mount();

    await act(async () => controller.testSpeaker());

    expect(controller.speaker.result).toBe('Audio device test failed');
  });

  it('resumes suspended audio and times out when the speaker tone never ends', async () => {
    vi.useFakeTimers();
    const close = vi.fn().mockResolvedValue(undefined);
    const resume = vi.fn().mockResolvedValue(undefined);
    const oscillator = {
      frequency: { value: 0 },
      connect: () => ({ connect: () => undefined }),
      start: vi.fn(),
      stop: vi.fn(),
      addEventListener: vi.fn(),
    };
    vi.stubGlobal('AudioContext', vi.fn(function AudioContextMock() {
      return {
        state: 'suspended', resume, currentTime: 0, destination: {}, close,
        createOscillator: () => oscillator,
        createGain: () => ({ gain: { value: 0 } }),
      };
    }));
    await mount();
    await act(async () => {
      const test = controller.testSpeaker();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2400);
      await test;
    });
    expect(resume).toHaveBeenCalledOnce();
    expect(controller.speaker.testing).toBe(false);
    expect(controller.speaker.result).toContain('扬声器测试未能完成');
    expect(close).toHaveBeenCalledOnce();
  });

  it('ignores microphone completion and failure from superseded runs', async () => {
    let resolveFirst!: (stream: { getTracks: () => never[] }) => void;
    const first = new Promise<{ getTracks: () => never[] }>((resolve) => { resolveFirst = resolve; });
    const getUserMedia = vi.fn()
      .mockImplementationOnce(() => first)
      .mockRejectedValueOnce(new Error('newer run failed'));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    const context = {
      createAnalyser: () => ({ fftSize: 1, getFloatTimeDomainData: () => undefined }),
      createMediaStreamSource: () => ({ connect: () => undefined }),
      close: vi.fn().mockRejectedValue(new Error('already closed')),
    };
    vi.stubGlobal('AudioContext', vi.fn(function AudioContextMock() { return context; }));
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
    await mount();

    const oldRun = controller.testMicrophone();
    const newRun = controller.testMicrophone();
    resolveFirst({ getTracks: () => [] });
    await act(async () => Promise.all([oldRun, newRun]));

    expect(controller.microphone.result).toBe('newer run failed');

    let rejectOld!: (error: unknown) => void;
    const oldFailure = new Promise((_resolve, reject) => { rejectOld = reject; });
    getUserMedia.mockImplementationOnce(() => oldFailure).mockRejectedValueOnce(new Error('latest failure'));
    const stale = controller.testMicrophone();
    const latest = controller.testMicrophone();
    rejectOld(new Error('stale failure'));
    await act(async () => Promise.all([stale, latest]));
    expect(controller.microphone.result).toBe('latest failure');
  });

  it('ignores speaker completion and catch state from superseded runs and tolerates close rejection', async () => {
    let finishOld!: () => void;
    let construction = 0;
    vi.stubGlobal('AudioContext', vi.fn(function AudioContextMock() {
      construction += 1;
      const oscillator = {
        frequency: { value: 0 },
        connect: () => ({ connect: () => undefined }),
        start: () => undefined,
        stop: () => undefined,
        addEventListener: (_name: string, listener: () => void) => {
          if (construction === 1) finishOld = listener;
          else listener();
        },
      };
      return {
        currentTime: 0,
        destination: {},
        createOscillator: () => oscillator,
        createGain: () => ({ gain: { value: 0 } }),
        close: vi.fn().mockRejectedValue(new Error('already closed')),
      };
    }));
    await mount();

    const oldRun = controller.testSpeaker();
    const newRun = controller.testSpeaker();
    await newRun;
    finishOld();
    await act(async () => oldRun);

    expect(controller.speaker.result).toBe('speaker passed');

    let reentered = false;
    vi.stubGlobal('AudioContext', vi.fn(function ReentrantAudioContextMock() {
      return {
        currentTime: 0,
        destination: {},
        createGain: () => ({ gain: { value: 0 } }),
        createOscillator: () => ({
          frequency: { value: 0 }, connect: () => ({ connect: () => undefined }), start: () => undefined, stop: () => undefined,
          addEventListener: () => {
            if (!reentered) {
              reentered = true;
              void controller.testSpeaker();
              throw new Error('stale speaker failure');
            }
          },
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
    }));
    await act(async () => controller.testSpeaker());
    expect(controller.speaker.result).not.toBe('stale speaker failure');
  });
});
