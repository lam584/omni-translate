import { invoke } from '@tauri-apps/api/core';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import type { AppConfigDraft } from '../schema/config';
import type { RuntimeSnapshot } from '../schema/runtime-core';
import type { AudioRuntimeSnapshot } from '../schema/audio-runtime';
import { isTauriRuntime } from './tauri-runtime';

export async function refreshAudioDevicesRuntime(): Promise<AudioRuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return audioRuntimeSnapshotMock;
  }

  return invoke<AudioRuntimeSnapshot>('refresh_audio_devices');
}

export async function startAudioRouteRuntime(direction: 'inbound' | 'outbound', config: AppConfigDraft): Promise<AudioRuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return {
      ...audioRuntimeSnapshotMock,
      inbound:
        direction === 'inbound'
          ? { ...audioRuntimeSnapshotMock.inbound, captureState: 'capturing' as const, streamBound: true }
          : audioRuntimeSnapshotMock.inbound,
      outbound:
        direction === 'outbound'
          ? { ...audioRuntimeSnapshotMock.outbound, captureState: 'capturing' as const, streamBound: true }
          : audioRuntimeSnapshotMock.outbound,
    } satisfies AudioRuntimeSnapshot;
  }

  return invoke<AudioRuntimeSnapshot>('start_audio_route', { direction, config });
}

export async function stopAudioRouteRuntime(direction: 'inbound' | 'outbound'): Promise<AudioRuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return audioRuntimeSnapshotMock;
  }

  return invoke<AudioRuntimeSnapshot>('stop_audio_route', { direction });
}

export async function clearSubtitleCuesRuntime(): Promise<AudioRuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return {
      ...audioRuntimeSnapshotMock,
      subtitleOverlay: {
        queueDepth: 0,
        droppedCueCount: 0,
        firstTranslationAverageMs: null,
        firstTranslationLastMs: null,
        firstTranslationSampleCount: 0,
        activeCue: null,
        recentCues: [],
      },
      speech: {
        ...audioRuntimeSnapshotMock.speech,
        queueDepth: 0,
        currentCueId: null,
      },
    } satisfies AudioRuntimeSnapshot;
  }

  return invoke<AudioRuntimeSnapshot>('clear_subtitle_cues');
}

export async function startSpeechDispatchRuntime(config: AppConfigDraft): Promise<AudioRuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return {
      ...audioRuntimeSnapshotMock,
      speech: {
        ...audioRuntimeSnapshotMock.speech,
        status: 'ready',
        dispatchState: 'playing',
        outputTarget: config.speech.outputTarget,
      },
    } satisfies AudioRuntimeSnapshot;
  }

  return invoke<AudioRuntimeSnapshot>('start_speech_dispatch', { config });
}

export async function stopSpeechDispatchRuntime(): Promise<AudioRuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return {
      ...audioRuntimeSnapshotMock,
      speech: {
        ...audioRuntimeSnapshotMock.speech,
        dispatchState: 'idle',
        currentCueId: null,
        currentRequestId: null,
      },
    } satisfies AudioRuntimeSnapshot;
  }

  return invoke<AudioRuntimeSnapshot>('stop_speech_dispatch');
}

export async function startTranslateWorkerRuntime(config: AppConfigDraft): Promise<AudioRuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return {
      ...audioRuntimeSnapshotMock,
      sessionStartedAt: new Date().toISOString(),
    } satisfies AudioRuntimeSnapshot;
  }

  return invoke<AudioRuntimeSnapshot>('start_translate_worker', { config });
}

export async function stopTranslateWorkerRuntime(): Promise<AudioRuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return audioRuntimeSnapshotMock;
  }

  return invoke<AudioRuntimeSnapshot>('stop_translate_worker');
}

export async function toggleSubtitleOverlayWindow(): Promise<RuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return runtimeSnapshotMock;
  }

  return invoke<RuntimeSnapshot>('toggle_subtitle_overlay');
}

export async function showSubtitleOverlayWindow(): Promise<RuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return {
      ...runtimeSnapshotMock,
      windows: runtimeSnapshotMock.windows.map((item) =>
        item.label === 'subtitle-overlay' ? { ...item, visible: true } : item,
      ),
    };
  }

  return invoke<RuntimeSnapshot>('show_subtitle_overlay');
}
