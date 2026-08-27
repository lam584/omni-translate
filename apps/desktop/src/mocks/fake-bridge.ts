import { appConfigDraftMock } from './app-config';
import { audioRuntimeSnapshotMock } from './audio-runtime';
import { runtimeSnapshotMock } from './runtime-shell';
import { BENCHMARK_PROGRESS_EVENT, type BenchmarkReport } from '../runtime/benchmark-runtime';
import type { ServiceErrorV2 } from '../runtime/desktop-api-v2';
import type {
  LiveSessionAsrDelta,
  LiveSessionEvents,
  LiveSessionOutputDelta,
} from '../runtime/live-session-events-runtime';
import {
  AUDIO_RUNTIME_SNAPSHOT_EVENT,
  type AudioRuntimeSnapshot,
  type SubtitleCueRuntime,
  type WatchSessionReportRuntime,
  type WatchTimelineEventRuntime,
} from '../schema/audio-runtime';
import type { AppConfigDraft, DiagnosticsExportScope } from '../schema/config';
import type {
  BridgeInlinePcmFrameHeader,
  DriverBridgeErrorCode,
} from '../schema/driver-bridge-contract';
import type { CredentialRefStatus, CredentialSecretPayload, ProviderSmokeResult } from '../schema/provider-runtime';
import {
  RUNTIME_NOTIFICATION_EVENT,
  RUNTIME_SNAPSHOT_EVENT,
  type DiagnosticsExportArtifact,
  type RuntimeSnapshot,
  type RuntimeNotification,
} from '../schema/runtime-core';
import type {
  BenchmarkHistoryClearResult,
  BenchmarkHistoryDeleteResult,
  BenchmarkHistoryPage,
  BenchmarkHistoryRecord,
  BenchmarkHistorySummary,
} from '../schema/generated/runtime-core';
import type { SpeechEventKind } from '../schema/speech-event-kinds';
import { resolveRealtimeProfile } from '../utils/realtime-profile';
import { resolveVirtualDriverCapability, VIRTUAL_MIC_PCM_FORMAT } from '../utils/virtual-driver-capability';
import { createLogger } from '../runtime/logger';

const fakeBridgeLogger = createLogger('runtime');
const FAKE_VIRTUAL_MIC_CAPTURE_ENDPOINT = 'Microphone (Omni Translate Virtual Microphone)';

/**
 * Injectable contract double for the desktop-runtime ↔ bridge boundary.
 *
 * The fake bridge mirrors the real backend's *shape*, not a convenient one:
 * commands are accept-and-return (`start_audio_route` acknowledges with an
 * armed, unbound snapshot), state converges asynchronously through the same
 * push-event channel the native side uses (`audio://snapshot`,
 * `runtime://snapshot`, `runtime://notification`, `runtime-v2://…`), and
 * failures arrive either as ServiceErrorV2 rejections or as later snapshots
 * carrying `lastError` / degraded status. Tests drive convergence explicitly
 * with `settle()` (or timers) instead of trusting command return values.
 */

export type FakeProvider = {
  translate: (sourceText: string) => string;
};

export function createFakeProvider(): FakeProvider {
  return {
    translate: (sourceText) => `译文：${sourceText}`,
  };
}

export type FakeBridgeCall = {
  command: string;
  action: string | null;
  args: Record<string, unknown> | undefined;
};

export type FakeOverlayWindowState = {
  locked: boolean;
  rounded: boolean;
  hotspotInteractive: boolean;
};

export type FakeTranslationDispatch = {
  cueId: string | null;
  requestId: string;
  translationSink: NonNullable<BridgeInlinePcmFrameHeader['translationSink']>;
  routeDirection: NonNullable<BridgeInlinePcmFrameHeader['routeDirection']>;
  status: 'completed' | 'route-failed';
  acceptedFrames: number;
  playbackFramesWritten: number;
  errorCode: DriverBridgeErrorCode | null;
};

/**
 * Wire shape of api_v2::ServiceErrorV2 — consumed directly from the runtime
 * layer's type so a contract change breaks this fake at compile time instead
 * of drifting silently.
 */
export type FakeServiceErrorV2 = ServiceErrorV2 & {
  details?: Record<string, unknown>;
};

/**
 * One streamed `benchmark://progress` payload. Mirrors
 * `benchmark::BenchmarkProgressState::emit`: every event carries the *partial*
 * report built so far, so the renderer can render a run before it finishes.
 */
export type FakeBenchmarkProgressStep = {
  phase: string;
  message: string;
  report: BenchmarkReport;
  status?: 'running' | 'completed' | 'error';
  error?: string | null;
  audioChunksSent?: number;
  totalAudioChunks?: number;
};

/** A programmed `provider_v2` benchmark run: progress stream + final outcome. */
export type FakeBenchmarkRun = {
  progress?: FakeBenchmarkProgressStep[];
  /** Final report; the native command returns it JSON-encoded as a string. */
  report?: BenchmarkReport;
  /** When set the run fails after streaming `progress` (ServiceErrorV2). */
  failure?: Partial<FakeServiceErrorV2> & { message: string };
};

export type FakeLiveSessionOptions = {
  model?: string;
  sessionStartedAt?: string;
  reportStatus?: WatchSessionReportRuntime['status'];
};

/** The five milestone names `LiveSessionEventBuffer::record_milestone` accepts. */
export type FakeLiveSessionMilestone =
  | 'preconnectStartedMs'
  | 'sessionReadyMs'
  | 'routeStartedMs'
  | 'firstAudioSentMs'
  | 'firstSpeechStartedMs';

type ServiceEnvelope<T> = { data: T; warnings: never[] };

type FakeEvent<T> = { event: string; payload: T };
type FakeEventHandler = (event: FakeEvent<never>) => void;

const SPEECH_FRAMES_PER_DISPATCH = 4800;
const CAPTURE_FRAMES_PER_START = 960;
/** Mirrors the backend reported by `storage_events::read_secret_ref`. */
const CREDENTIAL_BACKEND = 'windows-credential-manager';
/** Mirrors `PipelineMilestones::default()`. */
const EMPTY_PIPELINE_MILESTONES: LiveSessionEvents['pipelineMilestones'] = {
  preconnectStartedMs: null,
  sessionReadyMs: null,
  routeStartedMs: null,
  firstAudioSentMs: null,
  firstSpeechStartedMs: null,
  queuedAudioChunks: null,
  droppedBeforeReady: null,
  firstAudibleChunkMs: null,
  silenceSkippedBeforeAudible: null,
  totalInputChunksAtSpeech: null,
};

function envelope<T>(data: T): ServiceEnvelope<T> {
  return { data, warnings: [] };
}

/** Builds the ServiceErrorV2 the shell produces from a plain `Err(String)`. */
function serviceErrorV2(error: Partial<FakeServiceErrorV2> & { message: string }): FakeServiceErrorV2 {
  return {
    code: error.code ?? 'runtime.operation-failed',
    message: error.message,
    retriable: error.retriable ?? false,
    details: error.details ?? { rawError: error.message },
  };
}

function extractAction(args: Record<string, unknown> | undefined): string | null {
  const command = args?.command;
  if (command && typeof command === 'object' && 'action' in command) {
    return String((command as { action: unknown }).action);
  }
  return null;
}

export function createFakeBridge(provider: FakeProvider = createFakeProvider()) {
  const audio: AudioRuntimeSnapshot = structuredClone(audioRuntimeSnapshotMock);
  // Deterministic baseline: idle routes, no cues, zeroed dispatch counters, so
  // tests observe convergence rather than pre-baked activity.
  audio.inbound.captureState = 'idle';
  audio.inbound.streamBound = false;
  audio.outbound.captureState = 'idle';
  audio.outbound.streamBound = false;
  audio.sessionStartedAt = null;
  audio.sttConnection = {
    state: 'idle',
    reconnectAttempt: 0,
    maxReconnectAttempts: 0,
    lastDisconnectReason: null,
  };
  audio.subtitleOverlay = {
    streamId: 'fake-subtitle-stream',
    generation: 1,
    seq: 0,
    baselineIncluded: true,
    queueDepth: 0,
    droppedCueCount: 0,
    firstTranslationAverageMs: null,
    firstTranslationLastMs: null,
    firstTranslationSampleCount: 0,
    reportSessionId: null,
    activeCue: null,
    recentCues: [],
  };
  audio.speech = {
    ...audio.speech,
    status: 'ready',
    dispatchState: 'idle',
    queueDepth: 0,
    currentCueId: null,
    currentRequestId: null,
    speakerFramesWritten: 0,
    virtualMicFramesWritten: 0,
    lastError: null,
    recentEvents: [],
  };
  audio.status = 'ready';

  const runtime: RuntimeSnapshot = structuredClone(runtimeSnapshotMock);
  runtime.bridgeStatus = 'tauri-shell';

  /** Persisted config document behind `configuration_v2` load/save. */
  let configDocument: AppConfigDraft = structuredClone(appConfigDraftMock);
  let speechConfig: AppConfigDraft['speech'] = structuredClone(configDocument.speech);
  let speechBridgeCaptureMode: 'virtual-driver' | 'process-exclusion' | null = null;
  let speechBridgePlaybackEnabled = false;
  const benchmarkHistory = new Map<string, BenchmarkHistoryRecord>();
  let benchmarkHistorySequence = 0;

  const calls: FakeBridgeCall[] = [];
  let overlayWindowState: FakeOverlayWindowState | null = null;
  let cueSequence = 0;
  let dispatchSequence = 0;
  let eventSequence = 0;
  let runtimeEventSequence = 0;
  const translationDispatches: FakeTranslationDispatch[] = [];

  // ── Event bus (fake `listen`) ──

  const listeners = new Map<string, Set<FakeEventHandler>>();

  function listen<T>(eventName: string, handler: (event: FakeEvent<T>) => void): Promise<() => void> {
    const bucket = listeners.get(eventName) ?? new Set();
    bucket.add(handler as FakeEventHandler);
    listeners.set(eventName, bucket);
    return Promise.resolve(() => {
      bucket.delete(handler as FakeEventHandler);
    });
  }

  function emitEvent<T>(eventName: string, payload: T) {
    for (const handler of listeners.get(eventName) ?? []) {
      (handler as (event: FakeEvent<T>) => void)({ event: eventName, payload });
    }
  }

  function pushAudioSnapshot() {
    emitEvent(AUDIO_RUNTIME_SNAPSHOT_EVENT, structuredClone(audio));
  }

  function pushRuntimeSnapshot() {
    emitEvent(RUNTIME_SNAPSHOT_EVENT, structuredClone(runtime));
    runtimeEventSequence += 1;
    // Dynamic Rust event name: api_v2.rs formats `runtime-v2://{topic}`.
    emitEvent('runtime-v2://snapshot', {
      topic: 'snapshot',
      sequence: runtimeEventSequence,
      timestampMs: Date.now(),
      payload: structuredClone(runtime),
    });
  }

  function pushNotification(notification: RuntimeNotification) {
    runtime.notifications = [notification, ...runtime.notifications];
    emitEvent(RUNTIME_NOTIFICATION_EVENT, structuredClone(notification));
  }

  // ── Async convergence machinery ──
  //
  // Native workers finish route/speech transitions off the command path and
  // publish them via push events. The fake queues those transitions and runs
  // them either on the next macrotask (mirroring "shortly after the command
  // returns") or when a test calls `settle()` explicitly.

  const pendingConvergence: Array<() => void> = [];
  let convergenceTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleConvergence(step: () => void) {
    pendingConvergence.push(step);
    if (convergenceTimer === null) {
      convergenceTimer = setTimeout(() => {
        convergenceTimer = null;
        runPendingConvergence();
      }, 0);
    }
  }

  function runPendingConvergence() {
    while (pendingConvergence.length > 0) {
      const step = pendingConvergence.shift();
      step?.();
    }
  }

  /** Runs every queued native-side transition and delivers its push events. */
  async function settle() {
    runPendingConvergence();
    await Promise.resolve();
  }

  // ── Failure injection ──

  const pendingActionRejections = new Map<string, FakeServiceErrorV2>();
  const pendingRouteFailures = new Map<string, {
    lastError: string;
    lastErrorCode: string | null;
    recommendedAction: string | null;
  }>();
  let speechDegradeError: string | null = null;
  const heldStopDirections = new Set<string>();
  const heldInvokeActions = new Set<string>();

  function rejectNextAction(action: string, error: Partial<FakeServiceErrorV2> & { message: string }) {
    pendingActionRejections.set(action, serviceErrorV2(error));
  }

  /**
   * The next inbound/outbound route start is accepted but its worker fails:
   * the command still resolves with the armed snapshot, and the failure lands
   * asynchronously as a `lastError` snapshot push — the shape of a native
   * route-command timeout (`recommendedAction: 'restart-bridge'`) or a device
   * failure.
   */
  function failNextRouteStart(direction: 'inbound' | 'outbound', failure?: {
    lastError?: string;
    lastErrorCode?: string | null;
    recommendedAction?: string | null;
  }) {
    pendingRouteFailures.set(direction, {
      lastError: failure?.lastError ?? 'watch_mode.route_command_timeout: capture initialization timed out',
      lastErrorCode: failure?.lastErrorCode ?? null,
      recommendedAction: failure?.recommendedAction ?? 'restart-bridge',
    });
  }

  /**
   * The next speech dispatch cue bursts inside the worker (e.g. the speaker
   * device disappeared): the dispatch folds into `speech.lastError` +
   * status 'degraded', exactly like `speech/output.rs` failures.
   */
  function degradeNextSpeechDispatch(error = '扬声器设备缺失：无法打开输出流') {
    speechDegradeError = error;
  }

  /** The next stopRoute for `direction` sticks in 'stopping' (never converges). */
  function holdNextStopRoute(direction: 'inbound' | 'outbound') {
    heldStopDirections.add(direction);
  }

  /**
   * The next invoke carrying `action` resolves only after the native side has
   * already pushed its updated snapshot — the real-world interleaving where an
   * in-flight command's return value is staler than the event channel.
   */
  function holdInvokeUntilConvergence(action: string) {
    heldInvokeActions.add(action);
  }

  // ── Cue / subtitle machinery ──

  function pushCue(direction: 'inbound' | 'outbound', sourceText: string): SubtitleCueRuntime {
    cueSequence += 1;
    const translatedText = provider.translate(sourceText);
    const now = new Date().toISOString();
    const cue: SubtitleCueRuntime = {
      cueId: `fake-cue-${cueSequence}`,
      routeDirection: direction,
      sourceText,
      translatedText,
      displaySegments: [{ sourceText, translatedText, pending: false }],
      startedAt: now,
      endedAt: now,
      committed: true,
    };
    audio.subtitleOverlay.recentCues = [cue, ...audio.subtitleOverlay.recentCues];
    audio.subtitleOverlay.activeCue = cue;
    audio.subtitleOverlay.queueDepth = audio.subtitleOverlay.recentCues.length;
    return cue;
  }

  /**
   * Streams an uncommitted cue the way the native realtime path does: the
   * source text grows (or shrinks — providers re-hypothesize), the cue stays
   * uncommitted, and `displaySegments` is absent entirely (serde
   * skip_serializing_if omits it until display segmentation runs). Each chunk
   * is pushed over the event channel.
   */
  function streamCue(direction: 'inbound' | 'outbound', chunks: string[]): string {
    cueSequence += 1;
    const cueId = `fake-cue-${cueSequence}`;
    const startedAt = new Date().toISOString();
    for (const chunk of chunks) {
      const cue: SubtitleCueRuntime = {
        cueId,
        routeDirection: direction,
        sourceText: chunk,
        translatedText: '',
        startedAt,
        endedAt: startedAt,
        committed: false,
      };
      audio.subtitleOverlay.activeCue = cue;
      const existingIndex = audio.subtitleOverlay.recentCues.findIndex((item) => item.cueId === cueId);
      if (existingIndex >= 0) audio.subtitleOverlay.recentCues[existingIndex] = cue;
      else audio.subtitleOverlay.recentCues = [cue, ...audio.subtitleOverlay.recentCues];
      audio.subtitleOverlay.queueDepth = audio.subtitleOverlay.recentCues.length;
      pushAudioSnapshot();
    }
    return cueId;
  }

  /** Commits the active streamed cue: translation + display segments appear. */
  function commitActiveCue(): SubtitleCueRuntime {
    const active = audio.subtitleOverlay.activeCue;
    if (!active) throw new Error('fake bridge: no active cue to commit');
    const translatedText = provider.translate(active.sourceText);
    const committed: SubtitleCueRuntime = {
      ...active,
      translatedText,
      committed: true,
      displaySegments: [{ sourceText: active.sourceText, translatedText, pending: false }],
      endedAt: new Date().toISOString(),
    };
    audio.subtitleOverlay.activeCue = committed;
    audio.subtitleOverlay.recentCues = audio.subtitleOverlay.recentCues.map((item) =>
      item.cueId === committed.cueId ? committed : item,
    );
    pushAudioSnapshot();
    return committed;
  }

  // ── Realtime (STT) connection lifecycle ──

  function dropRealtimeConnection(reason = 'provider closed the WebSocket') {
    audio.sttConnected = false;
    audio.sttConnection = {
      state: 'reconnecting',
      reconnectAttempt: 1,
      maxReconnectAttempts: 5,
      lastDisconnectReason: reason,
    };
    // Mirrors realtime_ws::push_reconnecting_cue: the reconnect progress is
    // surfaced as a subtitle cue so the overlay shows it.
    pushCue('inbound', `[Omni] 正在重新连接实时翻译服务 (第 1/5)...`);
    pushAudioSnapshot();
  }

  function restoreRealtimeConnection() {
    audio.sttConnected = true;
    audio.sttConnection = {
      state: 'connected',
      reconnectAttempt: 0,
      maxReconnectAttempts: 5,
      lastDisconnectReason: null,
    };
    pushAudioSnapshot();
  }

  // ── Route lifecycle (accept → converge) ──

  function acceptRouteStart(direction: 'inbound' | 'outbound') {
    const route = direction === 'inbound' ? audio.inbound : audio.outbound;
    route.captureState = 'armed';
    route.streamBound = false;
    route.lastError = null;
    route.lastErrorCode = null;
    route.recommendedAction = null;

    const failure = pendingRouteFailures.get(direction);
    pendingRouteFailures.delete(direction);
    scheduleConvergence(() => {
      if (failure) {
        route.captureState = 'idle';
        route.streamBound = false;
        route.lastError = failure.lastError;
        route.lastErrorCode = failure.lastErrorCode;
        route.recommendedAction = failure.recommendedAction;
        audio.status = 'degraded';
      } else {
        route.captureState = 'capturing';
        route.streamBound = true;
        route.framesCaptured += CAPTURE_FRAMES_PER_START;
        route.segmentCount += 1;
        route.lastFrameAt = new Date().toISOString();
        audio.sttConnected = true;
        audio.sttConnection = {
          state: 'connected',
          reconnectAttempt: 0,
          maxReconnectAttempts: 5,
          lastDisconnectReason: null,
        };
        pushCue(direction, direction === 'inbound' ? 'fake inbound speech' : 'fake outbound speech');
      }
      pushAudioSnapshot();
    });
  }

  function acceptRouteStop(direction: 'inbound' | 'outbound') {
    const route = direction === 'inbound' ? audio.inbound : audio.outbound;
    route.captureState = 'stopping';
    route.streamBound = false;
    if (heldStopDirections.has(direction)) {
      // Stuck-in-stopping scenario: the native stop never converges.
      heldStopDirections.delete(direction);
      return;
    }
    scheduleConvergence(() => {
      route.captureState = 'idle';
      route.streamBound = false;
      audio.sessionStartedAt = null;
      pushAudioSnapshot();
    });
  }

  // ── Speech dispatch lifecycle ──

  function speechEvent(kind: SpeechEventKind, summary: string, cueId: string | null, requestId: string | null) {
    eventSequence += 1;
    audio.speech.recentEvents = [
      {
        eventId: `fake-speech-event-${eventSequence}`,
        kind,
        summary,
        emittedAt: new Date().toISOString(),
        cueId,
        requestId,
      },
      ...audio.speech.recentEvents,
    ];
  }

  /**
   * Real `start_speech_dispatch` semantics: the command only starts the
   * worker. It reports waiting-subtitle (enabled) or idle, and no frame
   * counter moves until a cue is actually dispatched.
   */
  function bridgeOwnsTranslationPlayback() {
    return speechBridgePlaybackEnabled
      && runtime.bridge.translationPlaybackEnabled
      && ['virtual-driver', 'process-exclusion'].includes(runtime.bridge.sourceCaptureMode);
  }

  function virtualMicOutputIsReady() {
    return resolveVirtualDriverCapability(runtime.bridge).virtualMicOutputReady;
  }

  function startSpeech(config: AppConfigDraft | undefined) {
    const enabled = config?.speech?.enabled ?? true;
    speechConfig = structuredClone(config?.speech ?? configDocument.speech);
    const feedbackMode = config?.devices.feedbackLoopPrevention ?? 'none';
    speechBridgeCaptureMode = feedbackMode === 'virtual-driver' || feedbackMode === 'process-exclusion'
      ? feedbackMode
      : null;
    speechBridgePlaybackEnabled = speechConfig.localPlaybackEnabled && speechBridgeCaptureMode !== null;
    audio.speech.status = 'ready';
    audio.speech.dispatchState = enabled ? 'waiting-subtitle' : 'idle';
    audio.speech.outputTarget = speechBridgePlaybackEnabled
      ? 'bridge-playback'
      : speechConfig.outputTarget;
    audio.speech.lastError = null;
  }

  function stopSpeech() {
    audio.speech.dispatchState = 'idle';
    audio.speech.currentCueId = null;
    audio.speech.currentRequestId = null;
    audio.speech.lastCompletedAt = new Date().toISOString();
    speechEvent('speech.stopped', 'speech dispatch stopped', null, null);
  }

  /**
   * Drives one worker-side dispatch of the active cue through the native
   * lifecycle: deferred → (cache-hit | realtime-audio-requested) → playing →
   * completed (or error + degraded when `degradeNextSpeechDispatch` armed).
   * Every stage is pushed over the event channel; the counters only advance
   * here, never at start_speech time.
   */
  function dispatchSpeechCue(options?: { cacheHit?: boolean }) {
    const cue = audio.subtitleOverlay.activeCue;
    dispatchSequence += 1;
    const requestId = `fake-tts-${dispatchSequence}`;
    const cueId = cue?.cueId ?? null;

    audio.speech.dispatchState = 'deferred';
    speechEvent('speech.deferred', 'cue queued behind subtitle approval', cueId, requestId);
    pushAudioSnapshot();

    scheduleConvergence(() => {
      if (speechDegradeError) {
        const error = speechDegradeError;
        speechDegradeError = null;
        audio.speech.dispatchState = 'error';
        audio.speech.lastError = error;
        audio.speech.status = 'degraded';
        speechEvent('speech.error', error, cueId, requestId);
        pushAudioSnapshot();
        return;
      }
      speechEvent(
        options?.cacheHit ? 'speech.cache-hit' : 'speech.realtime-audio-requested',
        options?.cacheHit ? 'cached audio reused' : 'realtime audio requested from provider',
        cueId,
        requestId,
      );
      audio.speech.dispatchState = 'playing';
      audio.speech.currentCueId = cueId;
      audio.speech.currentRequestId = requestId;
      audio.speech.lastStartedAt = new Date().toISOString();
      const routeDirection = cue?.routeDirection ?? 'inbound';
      const bridgePlayback = bridgeOwnsTranslationPlayback() && routeDirection === 'inbound';
      const localPlaybackEnabled = speechConfig.localPlaybackEnabled && speechBridgeCaptureMode === null;
      const virtualMicOutputEnabled = speechConfig.virtualMicOutputEnabled;
      const playToSpeaker = routeDirection === 'inbound'
        ? localPlaybackEnabled && !bridgePlayback
        : localPlaybackEnabled && !virtualMicOutputEnabled;
      const writeToVirtualMic = routeDirection === 'outbound' && virtualMicOutputEnabled;

      if (writeToVirtualMic) {
        if (!virtualMicOutputIsReady()) {
          const errorCode: DriverBridgeErrorCode = 'bridge.virtual-mic-output-unavailable';
          const configuredMode = speechBridgeCaptureMode ?? 'none';
          const error = `${errorCode}: cue=${cueId ?? '-'} configuredCaptureMode=${configuredMode} routeDirection=outbound virtualMicOutputSupported=${runtime.bridge.virtualMicOutputSupported} virtualMicOutputStatus=${runtime.bridge.virtualMicOutputStatus}; virtual microphone output capability is not ready`;
          translationDispatches.push({
            cueId,
            requestId,
            translationSink: 'virtual-mic',
            routeDirection,
            status: 'route-failed',
            acceptedFrames: 0,
            playbackFramesWritten: 0,
            errorCode,
          });
          runtime.bridge.lastErrorCode = errorCode;
          pushRuntimeSnapshot();
          appendDiagnosticsLog({
            category: 'audio',
            level: 'error',
            summary: errorCode,
            detail: error,
          });
          audio.speech.dispatchState = 'error';
          audio.speech.lastError = error;
          audio.speech.status = 'degraded';
          audio.speech.currentCueId = null;
          audio.speech.currentRequestId = null;
          speechEvent('speech.error', error, cueId, null);
          pushAudioSnapshot();
          return;
        }

        translationDispatches.push({
          cueId,
          requestId,
          translationSink: 'virtual-mic',
          routeDirection,
          status: 'completed',
          acceptedFrames: SPEECH_FRAMES_PER_DISPATCH,
          playbackFramesWritten: 0,
          errorCode: null,
        });
        audio.speech.virtualMicFramesWritten += SPEECH_FRAMES_PER_DISPATCH;
        runtime.bridge.translatedFramesAccepted += SPEECH_FRAMES_PER_DISPATCH;
        runtime.bridge.virtualMicFramesWritten =
          (runtime.bridge.virtualMicFramesWritten ?? 0) + SPEECH_FRAMES_PER_DISPATCH;
        runtime.bridge.virtualMicLastGeneration =
          (runtime.bridge.virtualMicLastGeneration ?? 0) + 1;
        runtime.bridge.virtualMicSessionActive = true;
        runtime.bridge.lastFrameTimestampMs = Date.now();
        runtime.bridge.lastErrorCode = null;
        pushRuntimeSnapshot();
      }

      if (bridgePlayback) {
        translationDispatches.push({
          cueId,
          requestId,
          translationSink: 'physical-playback',
          routeDirection,
          status: 'completed',
          acceptedFrames: SPEECH_FRAMES_PER_DISPATCH,
          playbackFramesWritten: SPEECH_FRAMES_PER_DISPATCH,
          errorCode: null,
        });
        runtime.bridge.translatedFramesAccepted += SPEECH_FRAMES_PER_DISPATCH;
        runtime.bridge.playbackFramesWritten += SPEECH_FRAMES_PER_DISPATCH;
        runtime.bridge.lastFrameTimestampMs = Date.now();
        runtime.bridge.lastErrorCode = null;
        pushRuntimeSnapshot();
      } else if (playToSpeaker) {
        audio.speech.speakerFramesWritten += SPEECH_FRAMES_PER_DISPATCH;
      }
      pushAudioSnapshot();

      audio.speech.dispatchState = 'waiting-subtitle';
      audio.speech.currentCueId = null;
      audio.speech.currentRequestId = null;
      audio.speech.lastCompletedAt = new Date().toISOString();
      const bridgeQueued = bridgePlayback;
      speechEvent(
        bridgeQueued ? 'speech.bridge-playback-queued' : 'speech.completed',
        bridgeQueued ? 'cue accepted by Bridge translation playback' : 'cue playback completed',
        cueId,
        requestId,
      );
      pushAudioSnapshot();
    });
  }

  function clearCues() {
    audio.subtitleOverlay.recentCues = [];
    audio.subtitleOverlay.activeCue = null;
    audio.subtitleOverlay.queueDepth = 0;
    audio.speech.queueDepth = 0;
    audio.speech.currentCueId = null;
  }

  function applyBridgeRunning(config: AppConfigDraft | undefined) {
    const feedbackMode = config?.devices.feedbackLoopPrevention ?? 'none';
    const sourceCaptureMode = feedbackMode === 'process-exclusion'
      ? 'process-exclusion' as const
      : feedbackMode === 'virtual-driver'
        ? 'virtual-driver' as const
        : 'none' as const;
    const captureBackend = sourceCaptureMode === 'process-exclusion'
      ? 'wasapi-process-exclusion' as const
      : sourceCaptureMode === 'virtual-driver'
        ? 'driver-virtual-speaker' as const
        : 'none' as const;
    const virtualMicOutputRequested = config?.speech.virtualMicOutputEnabled ?? false;
    const virtualMicOutputReady = sourceCaptureMode === 'virtual-driver' && virtualMicOutputRequested;
    runtime.bridge = {
      ...runtime.bridge,
      processStatus: 'running',
      bridgeState: 'running',
      lifecycleState: 'ready',
      driverHealth: sourceCaptureMode === 'virtual-driver' ? 'running' : 'not-installed',
      installPhase: 'ready',
      lastErrorCode: null,
      sessionId: 'fake-bridge-session',
      lastHandshakeAt: new Date().toISOString(),
      sourceCaptureMode,
      captureBackend,
      processLoopbackSupported: sourceCaptureMode === 'process-exclusion',
      processLoopbackStatus: sourceCaptureMode === 'process-exclusion' ? 'ready' : 'unknown',
      windowsBuildNumber: sourceCaptureMode === 'process-exclusion' || sourceCaptureMode === 'virtual-driver'
        ? 26_100
        : runtime.bridge.windowsBuildNumber,
      excludedProcessId: sourceCaptureMode === 'process-exclusion' ? 4_242 : null,
      processLoopbackFailureDetail: null,
      sourceMonitorPlaybackEnabled: sourceCaptureMode === 'virtual-driver'
        && (config?.speech.localPlaybackEnabled ?? true),
      translationPlaybackEnabled: sourceCaptureMode === 'process-exclusion'
        || (sourceCaptureMode === 'virtual-driver'
          && (config?.speech.localPlaybackEnabled ?? true)),
      virtualMicOutputRequested,
      virtualMicOutputSupported: virtualMicOutputReady,
      virtualMicOutputStatus: virtualMicOutputReady ? 'ready' : 'unsupported',
      captureEndpointName: virtualMicOutputReady ? FAKE_VIRTUAL_MIC_CAPTURE_ENDPOINT : null,
      virtualMicFormat: virtualMicOutputReady ? VIRTUAL_MIC_PCM_FORMAT : null,
      virtualMicSessionActive: false,
      expectedDriverVersion: config?.driver?.expectedDriverVersion ?? runtime.bridge.expectedDriverVersion,
      expectedBridgeVersion: config?.driver?.expectedBridgeVersion ?? runtime.bridge.expectedBridgeVersion,
    };
  }

  function applyBridgeStopped() {
    runtime.bridge = {
      ...runtime.bridge,
      processStatus: 'stopped',
      bridgeState: 'stopped',
      lifecycleState: 'stopped',
      sessionId: null,
      virtualMicSessionActive: false,
    };
  }

  function record(command: string, args: Record<string, unknown> | undefined) {
    calls.push({ command, action: extractAction(args), args });
  }

  function handleSessionAction(action: string | null, args: Record<string, unknown> | undefined) {
    const command = (args?.command ?? {}) as Record<string, unknown>;
    switch (action) {
      case 'startRoute':
        acceptRouteStart(command.direction as 'inbound' | 'outbound');
        break;
      case 'stopRoute':
        acceptRouteStop(command.direction as 'inbound' | 'outbound');
        break;
      case 'clearCues':
        clearCues();
        break;
      case 'startSpeech':
        startSpeech(command.config as AppConfigDraft | undefined);
        break;
      case 'stopSpeech':
        stopSpeech();
        break;
      case 'startTranslation':
        audio.sessionStartedAt = new Date().toISOString();
        break;
      case 'stopTranslation':
        audio.sessionStartedAt = null;
        break;
      case 'syncOverlayWindowState':
        overlayWindowState = {
          locked: Boolean(command.locked),
          rounded: Boolean(command.rounded),
          hotspotInteractive: Boolean(command.hotspotInteractive),
        };
        break;
      case 'snapshot':
      case 'bootstrap':
      case 'refreshDevices':
      case 'preconnect':
      case 'cancelPreconnect':
      case 'prewarmRoutes':
      case 'syncOverlayRegion':
        break;
      default:
        throw new Error(`fake bridge: unsupported session_v2 action ${String(action)}`);
    }
    return envelope(structuredClone(audio));
  }

  function handleBridgeAction(action: string | null, args: Record<string, unknown> | undefined) {
    const command = (args?.command ?? {}) as Record<string, unknown>;
    switch (action) {
      case 'snapshot':
        return envelope(structuredClone(runtime.bridge));
      case 'refresh':
        break;
      case 'start':
      case 'install':
      case 'repair':
        applyBridgeRunning(command.config as AppConfigDraft | undefined);
        break;
      case 'stop':
      case 'uninstall':
        applyBridgeStopped();
        break;
      default:
        throw new Error(`fake bridge: unsupported bridge_v2 action ${String(action)}`);
    }
    runtime.lastSyncAt = new Date().toISOString();
    return envelope(structuredClone(runtime));
  }

  // ── Credential vault (configuration_v2 secret* actions) ──
  //
  // `storage_events::{get_secret_ref_status,read_secret_ref}` answer from the
  // OS keyring: an unknown reference is not an error, it reports
  // `hasSecret: false` / `secret: null`.

  const credentialSecrets = new Map<string, string | null>();

  /** Stores (or, with `null`, clears) the secret behind a credential ref. */
  function setProviderSecret(reference: string, secret: string | null) {
    credentialSecrets.set(reference, secret);
  }

  function credentialStatus(reference: string): CredentialRefStatus {
    return {
      reference,
      backend: CREDENTIAL_BACKEND,
      hasSecret: Boolean(credentialSecrets.get(reference)),
    };
  }

  function credentialSecret(reference: string): CredentialSecretPayload {
    return {
      reference,
      backend: CREDENTIAL_BACKEND,
      secret: credentialSecrets.get(reference) ?? null,
    };
  }

  function handleConfigurationAction(action: string | null, args: Record<string, unknown> | undefined) {
    const command = (args?.command ?? {}) as Record<string, unknown>;
    switch (action) {
      case 'runtimeSnapshot':
      case 'bootstrapRuntime':
        return envelope(structuredClone(runtime));
      case 'load':
        return envelope(structuredClone(configDocument));
      case 'save':
        configDocument = structuredClone(command.config as AppConfigDraft);
        return envelope(structuredClone(runtime.storage));
      case 'secretStatus':
        return envelope(credentialStatus(String(command.reference ?? '')));
      case 'secretRead':
        return envelope(credentialSecret(String(command.reference ?? '')));
      case 'secretUpsert': {
        const reference = String(command.reference ?? '');
        credentialSecrets.set(reference, String(command.secret ?? ''));
        return envelope(credentialStatus(reference));
      }
      default:
        throw new Error(`fake bridge: unsupported configuration_v2 action ${String(action)}`);
    }
  }

  /** Diagnostics log ring visible through diagnostics_v2 snapshot. */
  const diagnosticsLogs: Array<Record<string, unknown>> = [];

  function appendDiagnosticsLog(entry: {
    category: string;
    level: string;
    summary: string;
    detail?: string | null;
  }) {
    diagnosticsLogs.unshift({
      id: `fake-log-${diagnosticsLogs.length + 1}`,
      category: entry.category,
      level: entry.level,
      summary: entry.summary,
      detail: entry.detail ?? null,
      emittedAt: new Date().toISOString(),
    });
  }

  // ── Live session event buffer (diagnostics_v2 liveSessionEvents) ──
  //
  // Mirrors `audio::live_session_events::LiveSessionEventBuffer`: workers push
  // deltas in arrival order and the finals are *derived* (the last non-blank
  // committed text wins) rather than set directly. The Rust snapshot's
  // `elapsedMs` is a wall clock; the fake reports the latest recorded event
  // time instead so tests stay deterministic.

  function createEmptyLiveSession(): LiveSessionEvents {
    return {
      sessionStartedAt: '',
      elapsedMs: 0,
      model: '',
      asrDeltas: [],
      outputDeltas: [],
      asrFinal: '',
      translationFinal: '',
      pipelineMilestones: { ...EMPTY_PIPELINE_MILESTONES },
    };
  }

  let liveSession = createEmptyLiveSession();
  let watchReportStatus: WatchSessionReportRuntime['status'] = 'completed';

  /** Mirrors `LiveSessionEventBuffer::clear`: a new session drops everything. */
  function startLiveSession(options: FakeLiveSessionOptions = {}) {
    liveSession = createEmptyLiveSession();
    watchReportStatus = options.reportStatus ?? 'completed';
    liveSession.model = options.model ?? '';
    liveSession.sessionStartedAt = options.sessionStartedAt ?? new Date().toISOString();
    audio.subtitleOverlay.reportSessionId = 'fake-watch-session';
  }

  function pushLiveAsrDelta(delta: LiveSessionAsrDelta) {
    liveSession.asrDeltas.push({ ...delta });
    if (delta.text.trim() !== '') {
      liveSession.asrFinal = delta.text;
    }
    liveSession.elapsedMs = Math.max(liveSession.elapsedMs, delta.elapsedMs);
  }

  function pushLiveOutputDelta(delta: LiveSessionOutputDelta) {
    liveSession.outputDeltas.push({ ...delta });
    if (delta.committedText !== '') {
      liveSession.translationFinal = delta.committedText;
    }
    liveSession.elapsedMs = Math.max(liveSession.elapsedMs, delta.elapsedMs);
  }

  function recordLiveMilestone(milestone: FakeLiveSessionMilestone, elapsedMs: number) {
    liveSession.pipelineMilestones[milestone] = elapsedMs;
    liveSession.elapsedMs = Math.max(liveSession.elapsedMs, elapsedMs);
  }

  function liveSessionAsWatchReport(): WatchSessionReportRuntime | null {
    if (!liveSession.sessionStartedAt) return null;
    const sourceEvents: WatchTimelineEventRuntime[] = liveSession.asrDeltas.map((delta, index) => ({
      eventId: `fake-source-${index}`,
      stage: 'source',
      kind: delta.eventType,
      elapsedMs: delta.elapsedMs,
      text: delta.text || delta.stash,
      detail: null,
      finalEvent: Boolean(delta.text),
      accepted: true,
      visible: null,
      callId: null,
      attemptId: null,
    }));
    const modelEvents: WatchTimelineEventRuntime[] = liveSession.outputDeltas.map((delta, index) => ({
      eventId: `fake-model-${index}`,
      stage: 'model',
      kind: delta.eventType,
      elapsedMs: delta.elapsedMs,
      text: delta.committedText || delta.stash,
      detail: null,
      finalEvent: Boolean(delta.committedText),
      accepted: true,
      visible: null,
      callId: 'fake-call-1',
      attemptId: 'fake-attempt-1',
    }));
    const sourceAtMs = liveSession.asrDeltas[0]?.elapsedMs ?? null;
    const llmFirstAtMs = liveSession.outputDeltas[0]?.elapsedMs ?? null;
    const llmFinalAtMs = [...liveSession.outputDeltas].reverse().find((event) => event.committedText)?.elapsedMs ?? null;
    const hasTranslation = Boolean(liveSession.translationFinal);
    const publishedAtMs = hasTranslation ? llmFinalAtMs : null;
    const renderedAtMs = hasTranslation && publishedAtMs != null ? publishedAtMs + 16 : null;
    const publishEvents: WatchTimelineEventRuntime[] = publishedAtMs == null ? [] : [{
      eventId: 'fake-publish-1',
      stage: 'publish',
      kind: 'subtitle-state-published',
      elapsedMs: publishedAtMs,
      text: liveSession.translationFinal,
      detail: null,
      finalEvent: true,
      accepted: true,
      visible: null,
      callId: 'fake-call-1',
      attemptId: 'fake-attempt-1',
    }];
    const renderEvents: WatchTimelineEventRuntime[] = renderedAtMs == null ? [] : [{
      eventId: 'fake-render-1',
      stage: 'render',
      kind: 'overlay-rendered',
      elapsedMs: renderedAtMs,
      text: liveSession.translationFinal,
      detail: null,
      finalEvent: true,
      accepted: true,
      visible: true,
      callId: null,
      attemptId: null,
    }];
    const timelineEvents = [...sourceEvents, ...modelEvents, ...publishEvents, ...renderEvents]
      .sort((left, right) => left.elapsedMs - right.elapsedMs);
    const between = (start: number | null, end: number | null) =>
      start != null && end != null && end >= start ? end - start : null;
    const cue = {
      cueId: 'fake-watch-cue-1',
      revision: 1,
      routeDirection: 'inbound' as const,
      translationPath: 'fake-provider',
      sourceText: liveSession.asrFinal,
      llmText: liveSession.translationFinal,
      publishedText: liveSession.translationFinal,
      publishedSegments: [],
      renderedSourceText: liveSession.asrFinal,
      renderedText: liveSession.translationFinal,
      comparisonStatus: hasTranslation ? 'exact' as const : 'pending' as const,
      sourceAtMs,
      llmFirstAtMs,
      llmFinalAtMs,
      publishedFirstAtMs: publishedAtMs,
      publishedFinalAtMs: publishedAtMs,
      renderedFirstAtMs: renderedAtMs,
      renderedFinalAtMs: renderedAtMs,
      sourceToLlmFirstMs: between(sourceAtMs, llmFirstAtMs),
      sourceToRenderMs: between(sourceAtMs, renderedAtMs),
      llmFirstToPublishMs: between(llmFirstAtMs, publishedAtMs),
      publishToRenderMs: between(publishedAtMs, renderedAtMs),
      llmFirstToRenderMs: between(llmFirstAtMs, renderedAtMs),
      llmFinalToPublishMs: between(llmFinalAtMs, publishedAtMs),
      publishedFinalToRenderMs: between(publishedAtMs, renderedAtMs),
      llmFinalToRenderMs: between(llmFinalAtMs, renderedAtMs),
      events: timelineEvents,
      issues: [],
      droppedEventCount: 0,
    };
    const sourceLatency = cue.sourceToLlmFirstMs;
    const endToEndLatency = cue.sourceToRenderMs;
    const renderLatency = cue.llmFirstToRenderMs;
    const finalLatency = cue.llmFinalToRenderMs;
    return {
      sessionId: 'fake-watch-session',
      status: watchReportStatus,
      routeMode: 'watch',
      providerId: 'fake-provider',
      model: liveSession.model,
      startedAt: liveSession.sessionStartedAt,
      endedAt: liveSession.sessionStartedAt,
      elapsedMs: liveSession.elapsedMs,
      summary: {
        durationMs: liveSession.elapsedMs,
        cueCount: 1,
        completeCueCount: hasTranslation ? 1 : 0,
        visibleRenderCueCount: hasTranslation ? 1 : 0,
        unrenderedCueCount: hasTranslation ? 0 : 1,
        issueCount: 0,
        issueOccurrenceCount: 0,
        averageSourceToLlmFirstMs: sourceLatency,
        p95SourceToLlmFirstMs: sourceLatency,
        maxSourceToLlmFirstMs: sourceLatency,
        averageSourceToRenderMs: endToEndLatency,
        p95SourceToRenderMs: endToEndLatency,
        maxSourceToRenderMs: endToEndLatency,
        averageLlmFirstToRenderMs: renderLatency,
        p95LlmFirstToRenderMs: renderLatency,
        maxLlmFirstToRenderMs: renderLatency,
        averageLlmFinalToRenderMs: finalLatency,
        p95LlmFinalToRenderMs: finalLatency,
        maxLlmFinalToRenderMs: finalLatency,
        slowestCueId: hasTranslation ? cue.cueId : null,
      },
      cues: [cue],
      events: timelineEvents,
      issues: [],
      droppedCueCount: 0,
      droppedEventCount: 0,
    };
  }

  function benchmarkHistorySummary(record: BenchmarkHistoryRecord): BenchmarkHistorySummary {
    return {
      recordId: record.recordId,
      runId: record.runId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      model: record.model,
      runStatus: record.runStatus,
      scoreStatus: record.scoreStatus,
      scoreVersion: record.scoreVersion,
      totalScore: record.totalScore,
      grade: record.grade,
      error: record.error,
    };
  }

  function readHistoryPage(value: unknown, fallback: number, maximum: number) {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isInteger(parsed) ? Math.min(maximum, Math.max(1, parsed)) : fallback;
  }

  function saveBenchmarkHistory(command: Record<string, unknown>): BenchmarkHistoryRecord {
    const runId = String(command.runId ?? '');
    const model = String(command.model ?? '');
    const runStatus = String(command.runStatus ?? '');
    const scoreStatus = String(command.scoreStatus ?? '');
    const validRunStatuses: BenchmarkHistoryRecord['runStatus'][] = ['running', 'completed', 'failed', 'interrupted'];
    const validScoreStatuses: BenchmarkHistoryRecord['scoreStatus'][] = ['pending', 'judging', 'final', 'evidence-insufficient', 'judge-failed', 'benchmark-failed'];
    if (!runId || !model || !validRunStatuses.includes(runStatus as BenchmarkHistoryRecord['runStatus']) || !validScoreStatuses.includes(scoreStatus as BenchmarkHistoryRecord['scoreStatus'])) {
      throw serviceErrorV2({ code: 'diagnostics.invalid-request', message: 'fake benchmark history record is invalid' });
    }
    if (command.scoreVersion != null && command.scoreVersion !== 'benchmark-score/v2') {
      throw serviceErrorV2({ code: 'diagnostics.invalid-request', message: 'fake benchmark history accepts benchmark-score/v2 writes only' });
    }

    const requestedRecordId = typeof command.recordId === 'string' && command.recordId.trim() ? command.recordId : null;
    const existing = requestedRecordId
      ? benchmarkHistory.get(requestedRecordId)
      : [...benchmarkHistory.values()].find((record) => record.runId === runId);
    if (requestedRecordId && !existing) {
      throw serviceErrorV2({ code: 'diagnostics.not-found', message: 'fake benchmark history record was not found' });
    }
    if (existing && existing.runId !== runId) {
      throw serviceErrorV2({ code: 'diagnostics.invalid-request', message: 'fake benchmark history record id does not match run id' });
    }

    const now = new Date().toISOString();
    const record: BenchmarkHistoryRecord = {
      recordId: existing?.recordId ?? `fake-benchmark-history-${++benchmarkHistorySequence}`,
      runId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      model,
      runStatus: runStatus as BenchmarkHistoryRecord['runStatus'],
      scoreStatus: scoreStatus as BenchmarkHistoryRecord['scoreStatus'],
      scoreVersion: 'benchmark-score/v2',
      totalScore: typeof command.totalScore === 'number' ? command.totalScore : null,
      grade: typeof command.grade === 'string' ? command.grade : null,
      report: command.report ?? null,
      score: command.score ?? null,
      error: typeof command.error === 'string' ? command.error : null,
    };
    benchmarkHistory.set(record.recordId, record);
    return structuredClone(record);
  }

  function listBenchmarkHistory(command: Record<string, unknown>): BenchmarkHistoryPage {
    const page = readHistoryPage(command.page, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = readHistoryPage(command.pageSize, 50, 100);
    const records = [...benchmarkHistory.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.recordId.localeCompare(left.recordId));
    return {
      records: records.slice((page - 1) * pageSize, page * pageSize).map(benchmarkHistorySummary),
      page,
      pageSize,
      totalCount: records.length,
    };
  }

  function getBenchmarkHistory(command: Record<string, unknown>): BenchmarkHistoryRecord {
    const recordId = String(command.recordId ?? '');
    const record = benchmarkHistory.get(recordId);
    if (!record) {
      throw serviceErrorV2({ code: 'diagnostics.not-found', message: 'fake benchmark history record was not found' });
    }
    return structuredClone(record);
  }

  function deleteBenchmarkHistory(command: Record<string, unknown>): BenchmarkHistoryDeleteResult {
    return { deleted: benchmarkHistory.delete(String(command.recordId ?? '')) };
  }

  function clearBenchmarkHistory(): BenchmarkHistoryClearResult {
    const deletedCount = benchmarkHistory.size;
    benchmarkHistory.clear();
    return { deletedCount };
  }

  function handleDiagnosticsAction(action: string | null, args: Record<string, unknown> | undefined) {
    const command = (args?.command ?? {}) as Record<string, unknown>;
    switch (action) {
      case 'snapshot':
        return envelope({ recentLogs: structuredClone(diagnosticsLogs) });
      case 'selfCheck':
      case 'overlaySelfCheck':
        return envelope(structuredClone(runtime));
      case 'export':
        return envelope(exportDiagnosticsBundle(String(command.scope ?? 'summary') as DiagnosticsExportScope));
      case 'watchSessionReport':
        return envelope(structuredClone(liveSessionAsWatchReport()));
      case 'clearWatchSessionReport':
        liveSession = createEmptyLiveSession();
        audio.subtitleOverlay.reportSessionId = null;
        return envelope(null);
      case 'openExportDirectory':
        return envelope(null);
      case 'writeExportArtifact':
        return envelope({
          outputPath: `C:\\Users\\fake\\Downloads\\${String(command.filename ?? 'watch-session-report.json')}`,
          fileCount: 1,
        });
      case 'saveBenchmarkHistory':
        return envelope(saveBenchmarkHistory(command));
      case 'listBenchmarkHistory':
        return envelope(listBenchmarkHistory(command));
      case 'getBenchmarkHistory':
        return envelope(getBenchmarkHistory(command));
      case 'deleteBenchmarkHistory':
        return envelope(deleteBenchmarkHistory(command));
      case 'clearBenchmarkHistory':
        return envelope(clearBenchmarkHistory());
      default:
        throw new Error(`fake bridge: unsupported diagnostics_v2 action ${String(action)}`);
    }
  }

  /**
   * Mirrors `diagnostics_events::export_diagnostics_bundle`: the bundle is
   * written, the export is marked on the diagnostics state (so the *next*
   * runtime snapshot carries it), a log line is appended and a runtime
   * snapshot is pushed — the artifact itself is only the receipt.
   */
  function exportDiagnosticsBundle(scope: DiagnosticsExportScope): DiagnosticsExportArtifact {
    const generatedAt = new Date().toISOString();
    const outputPath = `C:\\Users\\fake\\AppData\\Roaming\\omni-translate\\diagnostics\\exports\\${generatedAt.replace(/:/g, '-')}-${scope}`;
    runtime.diagnostics = {
      ...runtime.diagnostics,
      lastExportScope: scope,
      lastExportPath: outputPath,
      lastExportedAt: generatedAt,
    };
    appendDiagnosticsLog({
      category: 'runtime',
      level: 'info',
      summary: `已生成 diagnostics 导出包，scope=${scope}。`,
      detail: outputPath,
    });
    pushRuntimeSnapshot();
    return { scope, outputPath, generatedAt, fileCount: scope === 'full' ? 8 : 5 };
  }

  // ── Provider benchmark runs (provider_v2 runModelBenchmark) ──
  //
  // `benchmark::run_model_benchmark` streams `benchmark://progress` events
  // while the blocking task runs and finally returns the report as a JSON
  // *string*; a failing run emits its terminal error event first and then
  // rejects the command with a ServiceErrorV2.

  const benchmarkRuns: FakeBenchmarkRun[] = [];

  /** Queues the outcome of the next `runModelBenchmark` command. */
  function programBenchmarkRun(run: FakeBenchmarkRun) {
    benchmarkRuns.push(run);
  }

  function emitBenchmarkProgress(runId: string, step: Required<FakeBenchmarkProgressStep>) {
    emitEvent(BENCHMARK_PROGRESS_EVENT, {
      runId,
      status: step.status,
      phase: step.phase,
      message: step.message,
      report: structuredClone(step.report),
      error: step.error,
      audioChunksSent: step.audioChunksSent,
      totalAudioChunks: step.totalAudioChunks,
    });
  }

  function runProgrammedBenchmark(command: Record<string, unknown>): ServiceEnvelope<string> {
    const runId = String(command.runId ?? '');
    const plan = benchmarkRuns.shift();
    if (!plan) {
      // Native pre-flight: the run bails out before opening a socket when the
      // audio file is missing.
      throw serviceErrorV2({ message: `MP3 file not found: ${String(command.mp3Path ?? '')}` });
    }

    let lastStep: Required<FakeBenchmarkProgressStep> | null = null;
    for (const step of plan.progress ?? []) {
      lastStep = {
        phase: step.phase,
        message: step.message,
        report: step.report,
        status: step.status ?? 'running',
        error: step.error ?? null,
        audioChunksSent: step.audioChunksSent ?? 0,
        totalAudioChunks: step.totalAudioChunks ?? 0,
      };
      emitBenchmarkProgress(runId, lastStep);
    }

    if (plan.failure) {
      const error = serviceErrorV2(plan.failure);
      if (lastStep) {
        emitBenchmarkProgress(runId, {
          ...lastStep,
          status: 'error',
          phase: 'failed',
          message: error.message,
          error: error.message,
        });
      }
      throw error;
    }

    if (!plan.report) {
      throw serviceErrorV2({ message: 'fake bridge: programmed benchmark run has neither report nor failure' });
    }
    return envelope(JSON.stringify(plan.report));
  }

  function runFakeSemanticJudge(command: Record<string, unknown>): ServiceEnvelope<ProviderSmokeResult> {
    const providerConfig = command.provider as { providerId?: unknown; transport?: unknown } | undefined;
    let request: { runIndex?: unknown } = {};
    if (typeof command.sourceText === 'string') {
      try {
        request = JSON.parse(command.sourceText) as { runIndex?: unknown };
      } catch (error) {
        // The real provider will return a structured error for malformed
        // content. This test bridge preserves a valid fixture response so the
        // diagnostics page can exercise its one-shot judge lifecycle.
        fakeBridgeLogger.debug('fake benchmark judge request was not JSON', String(error));
        request = {};
      }
    }
    const transcript = JSON.stringify({
      subscores: {
        adequacy: 90,
        factsTerminology: 90,
        omissionsAdditions: 90,
        fluency: 90,
      },
      rationale: `Fake auditable semantic review for run ${Number(request.runIndex ?? 0) + 1}.`,
      criticalErrors: [],
    });
    return envelope({
      requestId: 'fake-benchmark-semantic-judge',
      providerId: typeof providerConfig?.providerId === 'string' ? providerConfig.providerId : 'fake-provider',
      status: 'completed',
      transportRequested: typeof providerConfig?.transport === 'string' ? providerConfig.transport : 'http',
      transportEffective: typeof providerConfig?.transport === 'string' ? providerConfig.transport : 'http',
      fallbackApplied: false,
      streamObserved: false,
      durationMs: 12,
      firstEventLatencyMs: 4,
      transcript,
      sourceLanguage: String(command.sourceLanguage ?? ''),
      targetLanguage: String(command.targetLanguage ?? ''),
      eventLog: [],
      inputTokens: null,
      outputTokens: null,
      audioSeconds: null,
      connectionAttempts: 0,
      connectionCount: 0,
      connectionOpened: false,
      connectionClosed: false,
      connectionOwner: null,
      connectionGeneration: null,
      routingDecision: { subtitlePriority: 'balanced', speechDisposition: 'ready', rationale: 'fake semantic judge' },
      error: null,
    });
  }

  function handleProviderAction(action: string | null, args: Record<string, unknown> | undefined) {
    const command = (args?.command ?? {}) as Record<string, unknown>;
    switch (action) {
      case 'resolveRealtimeProfile':
        return envelope(resolveRealtimeProfile(
          command.config as AppConfigDraft,
          String(command.modelReference ?? ''),
        ));
      case 'runModelBenchmark':
        return runProgrammedBenchmark(command);
      case 'smoke':
        return runFakeSemanticJudge(command);
      default:
        throw new Error(`fake bridge: unsupported provider_v2 action ${String(action)}`);
    }
  }

  async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    record(command, args);
    const action = extractAction(args);
    const rejectionKey = action ?? command;
    const rejection = pendingActionRejections.get(rejectionKey);
    if (rejection) {
      pendingActionRejections.delete(rejectionKey);
      return Promise.reject(rejection);
    }
    const holdKey = action ?? command;
    const holdUntilConverged = heldInvokeActions.delete(holdKey);

    const resolveValue = (): T => {
      switch (command) {
        case 'session_v2':
          return handleSessionAction(action, args) as T;
        case 'bridge_v2':
          return handleBridgeAction(action, args) as T;
        case 'provider_v2':
          return handleProviderAction(action, args) as T;
        case 'configuration_v2':
          return handleConfigurationAction(action, args) as T;
        case 'diagnostics_v2':
          return handleDiagnosticsAction(action, args) as T;
        case 'start_audio_route':
          acceptRouteStart(args?.direction as 'inbound' | 'outbound');
          return structuredClone(audio) as T;
        case 'sync_subtitle_overlay_window_state':
          overlayWindowState = {
            locked: Boolean(args?.locked),
            rounded: Boolean(args?.rounded),
            hotspotInteractive: Boolean(args?.hotspotInteractive),
          };
          return undefined as T;
        case 'unlock_subtitle_overlay':
          overlayWindowState = { locked: false, rounded: true, hotspotInteractive: false };
          return undefined as T;
        case 'toggle_subtitle_overlay':
        case 'show_subtitle_overlay':
          runtime.windows = runtime.windows.map((item) =>
            item.label === 'subtitle-overlay' ? { ...item, visible: command === 'show_subtitle_overlay' ? true : !item.visible } : item,
          );
          pushRuntimeSnapshot();
          return structuredClone(runtime) as T;
        case 'debug_ipc_ping':
          return 'pong' as T;
        case 'start_bridge_service':
          applyBridgeRunning(args?.config as AppConfigDraft | undefined);
          return structuredClone(runtime) as T;
        case 'append_frontend_diagnostics_logs':
        case 'set_diagnostics_log_level':
        case 'bootstrap_storage':
          return undefined as T;
        default:
          throw new Error(`fake bridge: unsupported command ${command}`);
      }
    };

    if (holdUntilConverged) {
      // The command's snapshot is captured now (acceptance state), but the
      // promise resolves only after the worker's newer push already landed —
      // the interleaving that makes "return value == current state" a lie.
      const value = resolveValue();
      await settle();
      return value;
    }
    return resolveValue();
  }

  return {
    invoke,
    listen,
    settle,
    calls,
    commandCalls: (command: string) => calls.filter((call) => call.command === command),
    sessionActionCalls: (action: string) =>
      calls.filter((call) =>
        (call.command === 'session_v2' && call.action === action) ||
        (call.command === 'sync_subtitle_overlay_window_state' && action === 'syncOverlayWindowState'),
      ),
    getAudioSnapshot: () => structuredClone(audio),
    getRuntimeSnapshot: () => structuredClone(runtime),
    getTranslationDispatches: () => structuredClone(translationDispatches),
    getLiveSessionEvents: () => structuredClone(liveSession),
    getWatchSessionReport: () => structuredClone(liveSessionAsWatchReport()),
    getOverlayWindowState: () => (overlayWindowState ? { ...overlayWindowState } : null),
    /**
     * Installs the machine state the native runtime reports (damaged driver,
     * stopped bridge, …). Every snapshot-returning command then answers from
     * it, exactly like the native RuntimeStateStore. `bridgeStatus` must stay
     * a backend value: `runtime-error` is synthesised by the renderer
     * bootstrap and never arrives over the bridge.
     */
    seedRuntimeSnapshot: (snapshot: RuntimeSnapshot) => {
      Object.assign(runtime, structuredClone(snapshot));
    },
    // Failure / scenario injection
    rejectNextAction,
    failNextRouteStart,
    degradeNextSpeechDispatch,
    holdNextStopRoute,
    holdInvokeUntilConvergence,
    // Native-side workers the tests drive explicitly
    dispatchSpeechCue,
    streamCue,
    commitActiveCue,
    dropRealtimeConnection,
    restoreRealtimeConnection,
    pushNotification,
    appendDiagnosticsLog,
    programBenchmarkRun,
    setProviderSecret,
    startLiveSession,
    pushLiveAsrDelta,
    pushLiveOutputDelta,
    recordLiveMilestone,
  };
}

export type FakeBridge = ReturnType<typeof createFakeBridge>;
