import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauriRuntime: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock('./tauri-runtime', () => ({
  isTauriRuntime: () => mocks.isTauriRuntime(),
}));

import {
  clearSubtitleCuesRuntime,
  cancelOmniPreconnectRuntime,
  getAudioRuntimeSnapshotRuntime,
  prewarmCaptureRoutesRuntime,
  refreshAudioDevicesRuntime,
  showSubtitleOverlayWindow,
  startAudioRouteRuntime,
  waitForWatchRouteReadyRuntime,
  preconnectOmniRealtimeRuntime,
  startSpeechDispatchRuntime,
  startTranslateWorkerRuntime,
  stopAudioRouteRuntime,
  stopSpeechDispatchRuntime,
  stopTranslateWorkerRuntime,
  toggleSubtitleOverlayWindow,
} from './audio-runtime';

describe('audio runtime', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.isTauriRuntime.mockReset().mockReturnValue(false);
  });

  it('provides complete browser preview snapshots', async () => {
    const config = structuredClone(appConfigDraftMock);
    config.speech.outputTarget = 'virtual-mic';

    expect((await refreshAudioDevicesRuntime()).status).toBe('preview');
    expect((await startAudioRouteRuntime('inbound', config)).inbound).toMatchObject({ captureState: 'capturing', streamBound: true });
    expect((await startAudioRouteRuntime('outbound', config)).outbound).toMatchObject({ captureState: 'capturing', streamBound: true });
    expect((await preconnectOmniRealtimeRuntime(config)).status).toBe('preview');
    expect((await stopAudioRouteRuntime('inbound')).status).toBe('preview');
    expect((await clearSubtitleCuesRuntime()).subtitleOverlay).toMatchObject({ queueDepth: 0, recentCues: [] });
    expect((await startSpeechDispatchRuntime(config)).speech).toMatchObject({ dispatchState: 'playing', outputTarget: 'virtual-mic' });
    expect((await stopSpeechDispatchRuntime()).speech).toMatchObject({ dispatchState: 'idle', currentCueId: null, currentRequestId: null });
    expect((await startTranslateWorkerRuntime(config)).sessionStartedAt).toEqual(expect.any(String));
    expect((await stopTranslateWorkerRuntime()).status).toBe('preview');
    expect((await toggleSubtitleOverlayWindow()).windows).toBeDefined();

    const overlay = await showSubtitleOverlayWindow();
    expect(overlay.windows.find((item) => item.label === 'subtitle-overlay')?.visible).toBe(true);
    expect(overlay.windows.find((item) => item.label !== 'subtitle-overlay')?.visible).toBe(true);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('maps every desktop action to its native invoke command', async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    mocks.invoke.mockImplementation(async (command: string) =>
      command === 'session_v2'
        ? { data: { status: 'ok' }, warnings: [] }
        : { command },
    );
    const config = structuredClone(appConfigDraftMock);

    await refreshAudioDevicesRuntime();
    await startAudioRouteRuntime('inbound', config);
    await preconnectOmniRealtimeRuntime(config);
    await stopAudioRouteRuntime('outbound');
    await clearSubtitleCuesRuntime();
    await startSpeechDispatchRuntime(config);
    await stopSpeechDispatchRuntime();
    await startTranslateWorkerRuntime(config);
    await stopTranslateWorkerRuntime();
    await toggleSubtitleOverlayWindow();
    await showSubtitleOverlayWindow();

    expect(mocks.invoke.mock.calls.map(([command, args]) => [
      command,
      (args as { command?: { action?: string } } | undefined)?.command?.action,
    ])).toEqual([
      ['session_v2', 'refreshDevices'],
      ['start_audio_route', undefined],
      ['session_v2', 'preconnect'],
      ['session_v2', 'stopRoute'],
      ['session_v2', 'clearCues'],
      ['session_v2', 'startSpeech'],
      ['session_v2', 'stopSpeech'],
      ['session_v2', 'startTranslation'],
      ['session_v2', 'stopTranslation'],
      ['toggle_subtitle_overlay', undefined],
      ['show_subtitle_overlay', undefined],
    ]);
    expect(mocks.invoke).toHaveBeenCalledWith('start_audio_route', { direction: 'inbound', config });
  });

  it('skips capture pre-warm entirely outside the Tauri runtime', async () => {
    const config = structuredClone(appConfigDraftMock);
    await expect(prewarmCaptureRoutesRuntime(config)).resolves.toBeUndefined();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('maps capture pre-warm to the session_v2 prewarmRoutes command', async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    mocks.invoke.mockResolvedValue({ data: { status: 'ok' }, warnings: [] });
    const config = structuredClone(appConfigDraftMock);

    await prewarmCaptureRoutesRuntime(config);

    expect(mocks.invoke).toHaveBeenCalledWith('session_v2', { command: { action: 'prewarmRoutes', config } });
  });

  it('never surfaces failures from capture pre-warm', async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    mocks.invoke.mockRejectedValue(new Error('device busy'));
    const config = structuredClone(appConfigDraftMock);

    await expect(prewarmCaptureRoutesRuntime(config)).resolves.toBeUndefined();
  });

  it('rejects with a timeout error when invoke does not respond in time', async () => {
    vi.useFakeTimers();
    mocks.isTauriRuntime.mockReturnValue(true);
    mocks.invoke.mockImplementation(() => new Promise(() => {})); // never resolves

    const promise = refreshAudioDevicesRuntime();

    vi.advanceTimersByTime(15_000);
    await expect(promise).rejects.toThrow(/刷新音频设备超时/);

    vi.useRealTimers();
  });

  it('clears timeout when invoke resolves before deadline', async () => {
    vi.useFakeTimers();
    mocks.isTauriRuntime.mockReturnValue(true);
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');

    mocks.invoke.mockImplementation(async (command: string) =>
      command === 'start_audio_route' ? { status: 'ok' } : { data: { status: 'ok' }, warnings: [] },
    );

    const result = await startAudioRouteRuntime('inbound', structuredClone(appConfigDraftMock));
    expect(result).toEqual({ status: 'ok' });
    expect(clearTimeoutSpy).toHaveBeenCalled();

    clearTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it('waits for the native Watch route to become usable after acknowledgement', async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    mocks.invoke
      .mockResolvedValueOnce({ data: { inbound: { captureState: 'armed', streamBound: false, framesCaptured: 0, lastError: null } } })
      .mockResolvedValueOnce({ data: { inbound: { captureState: 'capturing', streamBound: true, framesCaptured: 960, lastError: null } } });

    const snapshot = await waitForWatchRouteReadyRuntime(100);

    expect(snapshot.inbound).toMatchObject({ captureState: 'capturing', streamBound: true });
    expect(mocks.invoke.mock.calls.map(([command, args]) => [command, args?.command?.action])).toEqual([
      ['session_v2', 'snapshot'],
      ['session_v2', 'snapshot'],
    ]);
  });

  it('resolves as soon as the native capture stream is bound, without waiting for the first frame', async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    mocks.invoke
      .mockResolvedValueOnce({ data: { inbound: { captureState: 'capturing', streamBound: true, framesCaptured: 0, lastError: null } } })
      .mockResolvedValue({ data: { inbound: { captureState: 'buffering', streamBound: true, framesCaptured: 0, lastError: null } } });

    const snapshot = await waitForWatchRouteReadyRuntime(1_000);

    // Pipeline ready (bound stream) even though no audio frame has arrived yet:
    // watch clicks routinely precede the media starting, so "ready" must not
    // depend on the user's audio already playing.
    expect(snapshot.inbound.streamBound).toBe(true);
    expect(mocks.invoke.mock.calls.length).toBe(1);
  });

  it('fails Watch route readiness immediately when native initialization reports an error', async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    mocks.invoke.mockResolvedValue({ data: { inbound: { captureState: 'buffering', streamBound: false, lastError: 'capture unavailable' } } });

    await expect(waitForWatchRouteReadyRuntime(100)).rejects.toThrow('capture unavailable');
  });

  it('uses the default Watch readiness error when a changing native getter clears its detail', async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    let reads = 0;
    const inbound = {
      captureState: 'buffering',
      streamBound: false,
      get lastError() {
        reads += 1;
        return reads === 1 ? 'transient' : undefined;
      },
    };
    mocks.invoke.mockResolvedValue({ data: { inbound } });

    await expect(waitForWatchRouteReadyRuntime(100)).rejects.toThrow('系统音频采集未进入可用状态');
  });

  it('resolves as accepted-but-converging when the deadline passes without a native error, instead of tearing the route down', async () => {
    vi.useFakeTimers();
    mocks.isTauriRuntime.mockReturnValue(true);
    mocks.invoke.mockResolvedValue({ data: { inbound: { captureState: 'armed', streamBound: false, framesCaptured: 0, lastError: null } } });

    const readiness = waitForWatchRouteReadyRuntime(100);
    await vi.advanceTimersByTimeAsync(100);
    const snapshot = await readiness;

    // The native watch route keeps converging in the background and pushes a
    // bound/failed snapshot on its own, so a budget elapsed without a native
    // error must NOT be a launch failure: resolve with the converging snapshot.
    expect(snapshot.inbound).toMatchObject({ captureState: 'armed', streamBound: false, lastError: null });

    vi.useRealTimers();
  });

  it('still rejects immediately when native attributes a failure before the stream binds', async () => {
    vi.useFakeTimers();
    mocks.isTauriRuntime.mockReturnValue(true);
    mocks.invoke
      .mockResolvedValueOnce({ data: { inbound: { captureState: 'armed', streamBound: false, framesCaptured: 0, lastError: null } } })
      .mockResolvedValue({ data: { inbound: { captureState: 'buffering', streamBound: false, framesCaptured: 0, lastError: '系统音频采集已就绪，但在 4 秒内没有捕获到任何音频帧，设备可能已静音或被其他应用以独占模式占用。', recommendedAction: 'check-audio-source' } } });

    const readiness = waitForWatchRouteReadyRuntime(1_000);
    const rejection = expect(readiness).rejects.toThrow('没有捕获到任何音频帧');
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;

    vi.useRealTimers();
  });

  it('stops and refreshes native state when a route start succeeds after the frontend timeout', async () => {
    vi.useFakeTimers();
    mocks.isTauriRuntime.mockReturnValue(true);
    let finishStart!: (value: unknown) => void;
    const lateStart = new Promise((resolve) => { finishStart = resolve; });
    mocks.invoke.mockImplementation((command: string, args?: { command?: { action?: string } }) => {
      const action = args?.command?.action;
      if (command === 'start_audio_route') return lateStart;
      if (command === 'session_v2') return Promise.resolve({ data: { status: action }, warnings: [] });
      return Promise.resolve({});
    });

    const startPromise = startAudioRouteRuntime('inbound', structuredClone(appConfigDraftMock));
    const rejection = expect(startPromise).rejects.toThrow(/start audio capture|启动音频采集/);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;

    finishStart({ status: 'late-started' });
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mocks.invoke.mock.calls.map(([command, args]) => [command, args?.command?.action])).toEqual([
      ['start_audio_route', undefined],
      ['session_v2', 'stopRoute'],
      ['session_v2', 'snapshot'],
    ]);
    vi.useRealTimers();
  });

  it('covers browser fallbacks for snapshot reads, preconnect cancellation, and watch readiness', async () => {
    expect((await getAudioRuntimeSnapshotRuntime()).status).toBe('preview');
    expect((await cancelOmniPreconnectRuntime()).status).toBe('preview');
    expect((await waitForWatchRouteReadyRuntime(1)).inbound).toMatchObject({
      captureState: 'capturing',
      streamBound: true,
      framesCaptured: 960,
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('maps snapshot reads and preconnect cancellation through the IPC session adapter', async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    mocks.invoke.mockResolvedValue({ data: { status: 'ipc-ok' }, warnings: [] });

    await expect(getAudioRuntimeSnapshotRuntime()).resolves.toEqual({ status: 'ipc-ok' });
    await expect(cancelOmniPreconnectRuntime()).resolves.toEqual({ status: 'ipc-ok' });

    expect(mocks.invoke.mock.calls.map(([, args]) => args?.command?.action)).toEqual([
      'snapshot',
      'cancelPreconnect',
    ]);
  });

  it('propagates an IPC rejection and clears its timeout', async () => {
    vi.useFakeTimers();
    mocks.isTauriRuntime.mockReturnValue(true);
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    mocks.invoke.mockRejectedValue(new Error('ipc unavailable'));

    await expect(refreshAudioDevicesRuntime()).rejects.toThrow('ipc unavailable');
    expect(clearTimeoutSpy).toHaveBeenCalled();

    clearTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it('ignores a timeout callback that fires after an IPC promise already settled', async () => {
    vi.useFakeTimers();
    mocks.isTauriRuntime.mockReturnValue(true);
    vi.spyOn(window, 'clearTimeout').mockImplementation(() => undefined);
    mocks.invoke.mockResolvedValue({ data: { status: 'ready' }, warnings: [] });

    await expect(refreshAudioDevicesRuntime()).resolves.toEqual({ status: 'ready' });
    await vi.advanceTimersByTimeAsync(15_000);

    vi.useRealTimers();
  });

  it('honors both Error and non-Error abort reasons while polling watch readiness', async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    const errorController = new AbortController();
    errorController.abort(new Error('explicit abort'));
    await expect(waitForWatchRouteReadyRuntime(100, errorController.signal)).rejects.toThrow('explicit abort');

    const stringController = new AbortController();
    stringController.abort('cancelled');
    await expect(waitForWatchRouteReadyRuntime(100, stringController.signal)).rejects.toThrow('看片模式启动已取消');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each([
    ['speech', 30_000, startSpeechDispatchRuntime, 'startSpeech', 'stopSpeech'],
    ['translation', 60_000, startTranslateWorkerRuntime, 'startTranslation', 'stopTranslation'],
  ] as const)('compensates a late %s start after its renderer timeout', async (_label, timeoutMs, start, startAction, stopAction) => {
    vi.useFakeTimers();
    mocks.isTauriRuntime.mockReturnValue(true);
    let settleStart!: (value: unknown) => void;
    const lateStart = new Promise((resolve) => { settleStart = resolve; });
    mocks.invoke.mockImplementation((_command: string, args?: { command?: { action?: string } }) => {
      const action = args?.command?.action;
      if (action === startAction) return lateStart;
      return Promise.resolve({ data: { status: action }, warnings: [] });
    });

    const promise = start(structuredClone(appConfigDraftMock));
    const rejection = expect(promise).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(timeoutMs);
    await rejection;
    settleStart({ status: 'late' });
    await vi.runAllTimersAsync();
    await Promise.resolve();

    const actions = mocks.invoke.mock.calls.map(([, args]) => args?.command?.action);
    expect(actions).toContain(startAction);
    expect(actions).toContain(stopAction);
    expect(actions).toContain('snapshot');
    vi.useRealTimers();
  });

  it.each([
    ['route', 30_000, (config: typeof appConfigDraftMock) => startAudioRouteRuntime('inbound', config), 'start_audio_route'],
    ['speech', 30_000, startSpeechDispatchRuntime, 'startSpeech'],
    ['translation', 60_000, startTranslateWorkerRuntime, 'startTranslation'],
  ] as const)('recovers when a late %s IPC start rejects after timeout', async (_label, timeoutMs, start, startAction) => {
    vi.useFakeTimers();
    mocks.isTauriRuntime.mockReturnValue(true);
    let rejectStart!: (error: unknown) => void;
    const lateStart = new Promise((_resolve, reject) => { rejectStart = reject; });
    mocks.invoke.mockImplementation((command: string, args?: { command?: { action?: string } }) => {
      const action = command === 'start_audio_route' ? command : args?.command?.action;
      if (action === startAction) return lateStart;
      return Promise.resolve({ data: { status: action }, warnings: [] });
    });

    const promise = start(structuredClone(appConfigDraftMock));
    const rejection = expect(promise).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(timeoutMs);
    await rejection;
    rejectStart(new Error('late native rejection'));
    await vi.runAllTimersAsync();
    await Promise.resolve();

    vi.useRealTimers();
  });

  it('logs a timeout recovery failure without replacing the original timeout', async () => {
    vi.useFakeTimers();
    mocks.isTauriRuntime.mockReturnValue(true);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let settleStart!: (value: unknown) => void;
    const lateStart = new Promise((resolve) => { settleStart = resolve; });
    mocks.invoke.mockImplementation((_command: string, args?: { command?: { action?: string } }) => {
      const action = args?.command?.action;
      if (action === 'startSpeech') return lateStart;
      if (action === 'stopSpeech') return Promise.reject(new Error('cleanup failed'));
      return Promise.resolve({ data: { status: action }, warnings: [] });
    });

    const promise = startSpeechDispatchRuntime(structuredClone(appConfigDraftMock));
    const rejection = expect(promise).rejects.toThrow('启动语音播报超时');
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    settleStart({ status: 'late' });
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(consoleSpy).toHaveBeenCalledWith(
      '[omni][audio]',
      expect.stringContaining('启动语音播报 timeout recovery failed'),
      expect.any(String),
    );
    consoleSpy.mockRestore();
    vi.useRealTimers();
  });
});
