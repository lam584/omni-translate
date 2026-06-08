import { invoke } from '@tauri-apps/api/core';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import type { AppConfigDraft } from '../schema/config';
import type { RuntimeSnapshot } from '../schema/runtime-core';
import type { AudioRuntimeSnapshot } from '../schema/audio-runtime';
import { isTauriRuntime } from './tauri-runtime';

const AUDIO_ROUTE_TIMEOUT_MS = 30_000;
const OVERLAY_WINDOW_TIMEOUT_MS = 15_000;
const AUDIO_REFRESH_TIMEOUT_MS = 15_000;
const SPEECH_DISPATCH_TIMEOUT_MS = 30_000;
const TRANSLATE_WORKER_TIMEOUT_MS = 60_000;
const OMNI_PRECONNECT_TIMEOUT_MS = 15_000;

function createAudioRuntimeTimeoutError(actionLabel: string, timeoutMs: number) {
  return new Error(
    `${actionLabel}超时：${Math.ceil(timeoutMs / 1000)} 秒内未收到 Rust 运行时结果。请检查 Desktop Shell 终端和诊断日志。`,
  );
}

async function invokeAudioWithTimeout<T>(
  command: string,
  payload: Record<string, unknown> | undefined,
  actionLabel: string,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(createAudioRuntimeTimeoutError(actionLabel, timeoutMs));
    }, timeoutMs);

    invoke<T>(command, payload)
      .then((result) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(error);
      });
  });
}

export async function refreshAudioDevicesRuntime(): Promise<AudioRuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return audioRuntimeSnapshotMock;
  }

  return invokeAudioWithTimeout<AudioRuntimeSnapshot>('refresh_audio_devices', undefined, '刷新音频设备', AUDIO_REFRESH_TIMEOUT_MS);
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

  return invokeAudioWithTimeout<AudioRuntimeSnapshot>('start_audio_route', { direction, config }, '启动音频采集', AUDIO_ROUTE_TIMEOUT_MS);
}

export async function preconnectOmniRealtimeRuntime(config: AppConfigDraft): Promise<AudioRuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return audioRuntimeSnapshotMock;
  }

  return invokeAudioWithTimeout<AudioRuntimeSnapshot>('preconnect_omni_realtime', { config }, 'Omni 预连接', OMNI_PRECONNECT_TIMEOUT_MS);
}

export async function stopAudioRouteRuntime(direction: 'inbound' | 'outbound'): Promise<AudioRuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return audioRuntimeSnapshotMock;
  }

  return invokeAudioWithTimeout<AudioRuntimeSnapshot>('stop_audio_route', { direction }, '停止音频采集', AUDIO_ROUTE_TIMEOUT_MS);
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

  return invokeAudioWithTimeout<AudioRuntimeSnapshot>('clear_subtitle_cues', undefined, '清除字幕队列', OVERLAY_WINDOW_TIMEOUT_MS);
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

  return invokeAudioWithTimeout<AudioRuntimeSnapshot>('start_speech_dispatch', { config }, '启动语音播报', SPEECH_DISPATCH_TIMEOUT_MS);
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

  return invokeAudioWithTimeout<AudioRuntimeSnapshot>('stop_speech_dispatch', undefined, '停止语音播报', SPEECH_DISPATCH_TIMEOUT_MS);
}

export async function startTranslateWorkerRuntime(config: AppConfigDraft): Promise<AudioRuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return {
      ...audioRuntimeSnapshotMock,
      sessionStartedAt: new Date().toISOString(),
    } satisfies AudioRuntimeSnapshot;
  }

  return invokeAudioWithTimeout<AudioRuntimeSnapshot>('start_translate_worker', { config }, '启动翻译引擎', TRANSLATE_WORKER_TIMEOUT_MS);
}

export async function stopTranslateWorkerRuntime(): Promise<AudioRuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return audioRuntimeSnapshotMock;
  }

  return invokeAudioWithTimeout<AudioRuntimeSnapshot>('stop_translate_worker', undefined, '停止翻译引擎', TRANSLATE_WORKER_TIMEOUT_MS);
}

export async function toggleSubtitleOverlayWindow(): Promise<RuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return runtimeSnapshotMock;
  }

  return invokeAudioWithTimeout<RuntimeSnapshot>('toggle_subtitle_overlay', undefined, '切换字幕浮窗', OVERLAY_WINDOW_TIMEOUT_MS);
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

  return invokeAudioWithTimeout<RuntimeSnapshot>('show_subtitle_overlay', undefined, '显示字幕浮窗', OVERLAY_WINDOW_TIMEOUT_MS);
}
