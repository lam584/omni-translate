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
  refreshAudioDevicesRuntime,
  showSubtitleOverlayWindow,
  startAudioRouteRuntime,
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
    mocks.invoke.mockImplementation(async (command: string) => ({ command }));
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

    expect(mocks.invoke.mock.calls).toEqual([
      ['refresh_audio_devices', undefined],
      ['start_audio_route', { direction: 'inbound', config }],
      ['preconnect_omni_realtime', { config }],
      ['stop_audio_route', { direction: 'outbound' }],
      ['clear_subtitle_cues', undefined],
      ['start_speech_dispatch', { config }],
      ['stop_speech_dispatch', undefined],
      ['start_translate_worker', { config }],
      ['stop_translate_worker', undefined],
      ['toggle_subtitle_overlay', undefined],
      ['show_subtitle_overlay', undefined],
    ]);
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

    mocks.invoke.mockImplementation(async () => ({ status: 'ok' }));

    const result = await startAudioRouteRuntime('inbound', structuredClone(appConfigDraftMock));
    expect(result).toEqual({ status: 'ok' });
    expect(clearTimeoutSpy).toHaveBeenCalled();

    clearTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });
});
