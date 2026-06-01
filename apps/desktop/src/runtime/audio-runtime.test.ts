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
    await stopAudioRouteRuntime('outbound');
    await clearSubtitleCuesRuntime();
    await startSpeechDispatchRuntime(config);
    await stopSpeechDispatchRuntime();
    await startTranslateWorkerRuntime(config);
    await stopTranslateWorkerRuntime();
    await toggleSubtitleOverlayWindow();
    await showSubtitleOverlayWindow();

    expect(mocks.invoke.mock.calls).toEqual([
      ['refresh_audio_devices'],
      ['start_audio_route', { direction: 'inbound', config }],
      ['stop_audio_route', { direction: 'outbound' }],
      ['clear_subtitle_cues'],
      ['start_speech_dispatch', { config }],
      ['stop_speech_dispatch'],
      ['start_translate_worker', { config }],
      ['stop_translate_worker'],
      ['toggle_subtitle_overlay'],
      ['show_subtitle_overlay'],
    ]);
  });
});
