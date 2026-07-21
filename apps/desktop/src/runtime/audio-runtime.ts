import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import type { AppConfigDraft } from '../schema/config';
import type { RuntimeSnapshot } from '../schema/runtime-core';
import type { AudioRuntimeSnapshot } from '../schema/audio-runtime';
import { desktopApiV2 } from './desktop-api-v2';
import { isTauriRuntime } from './tauri-runtime';

const AUDIO_ROUTE_TIMEOUT_MS = 30_000;
const OVERLAY_WINDOW_TIMEOUT_MS = 15_000;
const AUDIO_REFRESH_TIMEOUT_MS = 15_000;
const SPEECH_DISPATCH_TIMEOUT_MS = 30_000;
const TRANSLATE_WORKER_TIMEOUT_MS = 60_000;
const WATCH_ROUTE_READY_POLL_MS = 40;
// The Rust command owns cancellation and cleanup (50s hard deadline). Keep the
// renderer deadline outside it so the UI cannot abandon a still-running task.
const OMNI_PRECONNECT_TIMEOUT_MS = 55_000;

function createAudioRuntimeTimeoutError(actionLabel: string, timeoutMs: number) {
  return new Error(
    `${actionLabel}超时：${Math.ceil(timeoutMs / 1000)} 秒内未收到 Rust 运行时结果。请检查 Desktop Shell 终端和诊断日志。`,
  );
}

async function invokeAudioWithTimeout<T>(
  operation: () => Promise<T>,
  actionLabel: string,
  timeoutMs: number,
  recoverAfterTimeout?: (settledOperation: Promise<T>) => Promise<void>,
): Promise<T> {
  const pendingOperation = operation();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(createAudioRuntimeTimeoutError(actionLabel, timeoutMs));
      if (recoverAfterTimeout) {
        void recoverAfterTimeout(pendingOperation).catch((error) => {
          console.error(`[audio-runtime] ${actionLabel} timeout recovery failed`, error);
        });
      }
    }, timeoutMs);

    pendingOperation
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

  return invokeAudioWithTimeout(() => desktopApiV2.session.refreshDevices(), '刷新音频设备', AUDIO_REFRESH_TIMEOUT_MS);
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

  return invokeAudioWithTimeout(
    // Route startup uses the direct native command. The V2 wrapper remains
    // available for other session operations, but must not sit between the
    // click path and the sub-second native acknowledgement.
    () => desktopApiV2.runtime.invoke<AudioRuntimeSnapshot>('start_audio_route', { direction, config }),
    '启动音频采集',
    AUDIO_ROUTE_TIMEOUT_MS,
    async (lateStart) => {
      await lateStart.catch(() => undefined);
      await desktopApiV2.session.stopRoute(direction);
      await desktopApiV2.session.snapshot();
    },
  );
}

function watchRouteNotReadyError(snapshot: AudioRuntimeSnapshot) {
  return new Error(snapshot.inbound.lastError ?? '系统音频采集未进入可用状态。');
}

export async function waitForWatchRouteReadyRuntime(timeoutMs: number, signal?: AbortSignal): Promise<AudioRuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return {
      ...audioRuntimeSnapshotMock,
      inbound: { ...audioRuntimeSnapshotMock.inbound, captureState: 'capturing', streamBound: true, framesCaptured: 960 },
    } satisfies AudioRuntimeSnapshot;
  }

  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('看片模式启动已取消。');
    }
    const snapshot = await desktopApiV2.session.snapshot();
    if (snapshot.inbound.lastError) throw watchRouteNotReadyError(snapshot);
    const routeReady = snapshot.inbound.captureState === 'capturing' && snapshot.inbound.streamBound;
    // A route that binds its stream but never captures a frame (muted device or
    // exclusive-mode conflict) must not count as success. Keep polling until
    // audio actually flows, or until the native flow-health watchdog attributes
    // the silence via lastError; never resolve on stream binding alone.
    if (routeReady && snapshot.inbound.framesCaptured > 0) return snapshot;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        routeReady
          ? '系统音频采集已就绪，但启动期限内没有捕获到任何音频帧。请确认音频源正在播放、设备未静音，且未被其他应用独占。'
          : '系统音频采集未在启动期限内就绪。',
      );
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, Math.min(WATCH_ROUTE_READY_POLL_MS, remainingMs)));
  }
}

export async function getAudioRuntimeSnapshotRuntime(): Promise<AudioRuntimeSnapshot> {
  if (!isTauriRuntime()) return audioRuntimeSnapshotMock;
  return invokeAudioWithTimeout(() => desktopApiV2.session.snapshot(), '读取音频运行状态', AUDIO_REFRESH_TIMEOUT_MS);
}

export async function preconnectOmniRealtimeRuntime(config: AppConfigDraft): Promise<AudioRuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return audioRuntimeSnapshotMock;
  }

  return invokeAudioWithTimeout(() => desktopApiV2.session.preconnect(config), 'Omni 预连接', OMNI_PRECONNECT_TIMEOUT_MS);
}

export async function cancelOmniPreconnectRuntime(): Promise<AudioRuntimeSnapshot> {
  if (!isTauriRuntime()) return audioRuntimeSnapshotMock;
  return invokeAudioWithTimeout(() => desktopApiV2.session.cancelPreconnect(), '取消 Omni 预连接', OMNI_PRECONNECT_TIMEOUT_MS);
}

export async function stopAudioRouteRuntime(direction: 'inbound' | 'outbound'): Promise<AudioRuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return audioRuntimeSnapshotMock;
  }

  return invokeAudioWithTimeout(() => desktopApiV2.session.stopRoute(direction), '停止音频采集', AUDIO_ROUTE_TIMEOUT_MS);
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

  return invokeAudioWithTimeout(() => desktopApiV2.session.clearCues(), '清除字幕队列', OVERLAY_WINDOW_TIMEOUT_MS);
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

  return invokeAudioWithTimeout(
    () => desktopApiV2.session.startSpeech(config),
    '启动语音播报',
    SPEECH_DISPATCH_TIMEOUT_MS,
    async (lateStart) => {
      await lateStart.catch(() => undefined);
      await desktopApiV2.session.stopSpeech();
      await desktopApiV2.session.snapshot();
    },
  );
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

  return invokeAudioWithTimeout(() => desktopApiV2.session.stopSpeech(), '停止语音播报', SPEECH_DISPATCH_TIMEOUT_MS);
}

export async function startTranslateWorkerRuntime(config: AppConfigDraft): Promise<AudioRuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return {
      ...audioRuntimeSnapshotMock,
      sessionStartedAt: new Date().toISOString(),
    } satisfies AudioRuntimeSnapshot;
  }

  return invokeAudioWithTimeout(
    () => desktopApiV2.session.startTranslation(config),
    '启动翻译引擎',
    TRANSLATE_WORKER_TIMEOUT_MS,
    async (lateStart) => {
      await lateStart.catch(() => undefined);
      await desktopApiV2.session.stopTranslation();
      await desktopApiV2.session.snapshot();
    },
  );
}

export async function stopTranslateWorkerRuntime(): Promise<AudioRuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return audioRuntimeSnapshotMock;
  }

  return invokeAudioWithTimeout(() => desktopApiV2.session.stopTranslation(), '停止翻译引擎', TRANSLATE_WORKER_TIMEOUT_MS);
}

export async function toggleSubtitleOverlayWindow(): Promise<RuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return runtimeSnapshotMock;
  }

  return invokeAudioWithTimeout(() => invoke<RuntimeSnapshot>('toggle_subtitle_overlay'), '切换字幕浮窗', OVERLAY_WINDOW_TIMEOUT_MS);
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

  return invokeAudioWithTimeout(() => invoke<RuntimeSnapshot>('show_subtitle_overlay'), '显示字幕浮窗', OVERLAY_WINDOW_TIMEOUT_MS);
}
import { invoke } from '@tauri-apps/api/core';
