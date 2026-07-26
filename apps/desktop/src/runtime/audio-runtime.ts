import i18n from '../i18n/config';
import type { AppConfigDraft } from '../schema/config';
import type { RuntimeSnapshot } from '../schema/runtime-core';
import type { AudioRuntimeSnapshot } from '../schema/audio-runtime';
import { activeDesktopApi } from './desktop-api';
import { invokeWithTimeoutCore } from './invoke-with-timeout';
import { createLogger } from './logger';

const audioLogger = createLogger('audio');

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
    i18n.t('runtime.audio.timeoutError', { action: actionLabel, seconds: Math.ceil(timeoutMs / 1000) }),
  );
}

async function invokeAudioWithTimeout<T>(
  operation: () => Promise<T>,
  actionLabel: string,
  timeoutMs: number,
  recoverAfterTimeout?: (settledOperation: Promise<T>) => Promise<void>,
): Promise<T> {
  return invokeWithTimeoutCore(
    operation,
    timeoutMs,
    () => createAudioRuntimeTimeoutError(actionLabel, timeoutMs),
    recoverAfterTimeout
      ? {
          onTimeout: (pendingOperation) => {
            void recoverAfterTimeout(pendingOperation).catch((error) => {
              audioLogger.error(
                `${actionLabel} timeout recovery failed`,
                error instanceof Error ? error.message : String(error),
              );
            });
          },
        }
      : undefined,
  );
}

export async function refreshAudioDevicesRuntime(): Promise<AudioRuntimeSnapshot> {
  return invokeAudioWithTimeout(() => activeDesktopApi().session.refreshDevices(), i18n.t('runtime.audio.actionRefreshDevices'), AUDIO_REFRESH_TIMEOUT_MS);
}

export async function startAudioRouteRuntime(direction: 'inbound' | 'outbound', config: AppConfigDraft): Promise<AudioRuntimeSnapshot> {
  return invokeAudioWithTimeout(
    // Route startup uses `session.startAudioRoute`, the legacy direct-command
    // wrapper (not the `startRoute` V2 envelope): it must not put the
    // ServiceResult unwrap between the click path and the sub-second native
    // acknowledgement.
    () => activeDesktopApi().session.startAudioRoute(direction, config),
    i18n.t('runtime.audio.actionStartCapture'),
    AUDIO_ROUTE_TIMEOUT_MS,
    async (lateStart) => {
      await lateStart.catch(() => undefined);
      await activeDesktopApi().session.stopRoute(direction);
      await activeDesktopApi().session.snapshot();
    },
  );
}

function watchRouteNotReadyError(snapshot: AudioRuntimeSnapshot) {
  return new Error(snapshot.inbound.lastError ?? i18n.t('runtime.audio.watchRouteNotReady'));
}

export async function waitForWatchRouteReadyRuntime(timeoutMs: number, signal?: AbortSignal): Promise<AudioRuntimeSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error(i18n.t('runtime.audio.watchCancelled'));
    }
    const snapshot = await activeDesktopApi().session.snapshot();
    if (snapshot.inbound.lastError) throw watchRouteNotReadyError(snapshot);
    // "Ready" means the capture worker owns a bound stream (pipeline ready). We
    // deliberately do NOT wait for the first audio frame here: `captureState`
    // only reports 'capturing' while speech is actively detected and falls back
    // to 'buffering' during silence, so gating on frames couples "ready" to
    // "the user's audio is already playing loudly" and surfaces as a false
    // launch timeout when someone clicks watch before starting the media. A
    // stream that binds but never delivers frames (muted / exclusive-mode
    // device) is attributed by the native flow-health watchdog and surfaces as
    // a post-launch `lastError`, which the polling above rethrows on the next
    // snapshot the controller observes.
    if (snapshot.inbound.streamBound) return snapshot;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      // Budget elapsed without a bound stream AND without a native `lastError`.
      // The native watch route is fire-and-converge: `start_audio_route` only
      // acknowledges the command, and the capture worker keeps initializing in
      // the background, pushing an audio snapshot (`streamBound=true`) once the
      // stream binds, or a `lastError` if it ultimately fails. Both reach the
      // store through the global audio-snapshot event listener, so we must NOT
      // treat "accepted but not bound yet" as a launch failure and let the caller
      // tear the route down — doing so killed watch mode whenever readiness took
      // a little longer than the client budget (which is what made clicking watch
      // appear to do nothing). Resolve with the latest, still-converging snapshot
      // and let the native push events drive the UI to capturing (or surface the
      // error). This is deliberately not a longer timeout: the budget is
      // unchanged, only its no-error outcome is now non-destructive.
      return snapshot;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, Math.min(WATCH_ROUTE_READY_POLL_MS, remainingMs)));
  }
}

export async function getAudioRuntimeSnapshotRuntime(): Promise<AudioRuntimeSnapshot> {
  return invokeAudioWithTimeout(() => activeDesktopApi().session.snapshot(), i18n.t('runtime.audio.actionReadSnapshot'), AUDIO_REFRESH_TIMEOUT_MS);
}

export async function preconnectOmniRealtimeRuntime(config: AppConfigDraft): Promise<AudioRuntimeSnapshot> {
  return invokeAudioWithTimeout(() => activeDesktopApi().session.preconnect(config), i18n.t('runtime.audio.actionPreconnect'), OMNI_PRECONNECT_TIMEOUT_MS);
}

export async function cancelOmniPreconnectRuntime(): Promise<AudioRuntimeSnapshot> {
  return invokeAudioWithTimeout(() => activeDesktopApi().session.cancelPreconnect(), i18n.t('runtime.audio.actionCancelPreconnect'), OMNI_PRECONNECT_TIMEOUT_MS);
}

/**
 * Best-effort idle-time pre-open of capture devices so a later route start only
 * has to `start_stream`. Shared by watch and conversation modes; a no-op outside
 * the Tauri runtime. Failures never propagate — this only speeds up a later
 * click and must never block or fail startup.
 */
export async function prewarmCaptureRoutesRuntime(config: AppConfigDraft): Promise<void> {
  try {
    await activeDesktopApi().session.prewarmRoutes(config);
  } catch {
    // Warming is purely an optimization; ignore failures and fall back to cold start.
  }
}

export async function stopAudioRouteRuntime(direction: 'inbound' | 'outbound'): Promise<AudioRuntimeSnapshot> {
  return invokeAudioWithTimeout(() => activeDesktopApi().session.stopRoute(direction), i18n.t('runtime.audio.actionStopCapture'), AUDIO_ROUTE_TIMEOUT_MS);
}

export async function clearSubtitleCuesRuntime(): Promise<AudioRuntimeSnapshot> {
  return invokeAudioWithTimeout(() => activeDesktopApi().session.clearCues(), i18n.t('runtime.audio.actionClearCues'), OVERLAY_WINDOW_TIMEOUT_MS);
}

export async function startSpeechDispatchRuntime(config: AppConfigDraft): Promise<AudioRuntimeSnapshot> {
  return invokeAudioWithTimeout(
    () => activeDesktopApi().session.startSpeech(config),
    i18n.t('runtime.audio.actionStartSpeech'),
    SPEECH_DISPATCH_TIMEOUT_MS,
    async (lateStart) => {
      await lateStart.catch(() => undefined);
      await activeDesktopApi().session.stopSpeech();
      await activeDesktopApi().session.snapshot();
    },
  );
}

export async function stopSpeechDispatchRuntime(): Promise<AudioRuntimeSnapshot> {
  return invokeAudioWithTimeout(() => activeDesktopApi().session.stopSpeech(), i18n.t('runtime.audio.actionStopSpeech'), SPEECH_DISPATCH_TIMEOUT_MS);
}

export async function startTranslateWorkerRuntime(config: AppConfigDraft): Promise<AudioRuntimeSnapshot> {
  return invokeAudioWithTimeout(
    () => activeDesktopApi().session.startTranslation(config),
    i18n.t('runtime.audio.actionStartTranslation'),
    TRANSLATE_WORKER_TIMEOUT_MS,
    async (lateStart) => {
      await lateStart.catch(() => undefined);
      await activeDesktopApi().session.stopTranslation();
      await activeDesktopApi().session.snapshot();
    },
  );
}

export async function stopTranslateWorkerRuntime(): Promise<AudioRuntimeSnapshot> {
  return invokeAudioWithTimeout(() => activeDesktopApi().session.stopTranslation(), i18n.t('runtime.audio.actionStopTranslation'), TRANSLATE_WORKER_TIMEOUT_MS);
}

export async function toggleSubtitleOverlayWindow(): Promise<RuntimeSnapshot> {
  return invokeAudioWithTimeout(() => activeDesktopApi().overlay.toggle(), i18n.t('runtime.audio.actionToggleOverlay'), OVERLAY_WINDOW_TIMEOUT_MS);
}

export async function showSubtitleOverlayWindow(): Promise<RuntimeSnapshot> {
  return invokeAudioWithTimeout(() => activeDesktopApi().overlay.show(), i18n.t('runtime.audio.actionShowOverlay'), OVERLAY_WINDOW_TIMEOUT_MS);
}
