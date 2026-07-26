import { audioRuntimeSnapshotMock } from './audio-runtime';
import { runtimeSnapshotMock } from './runtime-shell';
import type { AudioRuntimeSnapshot, SubtitleCueRuntime } from '../schema/audio-runtime';
import type { AppConfigDraft } from '../schema/config';
import type { RuntimeSnapshot, RuntimeNotification } from '../schema/runtime-core';
import type { SpeechEventKind } from '../schema/speech-event-kinds';

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

/** Wire shape of api_v2::ServiceErrorV2. */
export type FakeServiceErrorV2 = {
  code: string;
  message: string;
  retriable: boolean;
  details?: Record<string, unknown>;
};

type ServiceEnvelope<T> = { data: T; warnings: never[] };

type FakeEvent<T> = { event: string; payload: T };
type FakeEventHandler = (event: FakeEvent<never>) => void;

const SPEECH_FRAMES_PER_DISPATCH = 4800;
const CAPTURE_FRAMES_PER_START = 960;

function envelope<T>(data: T): ServiceEnvelope<T> {
  return { data, warnings: [] };
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
    queueDepth: 0,
    droppedCueCount: 0,
    firstTranslationAverageMs: null,
    firstTranslationLastMs: null,
    firstTranslationSampleCount: 0,
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

  const calls: FakeBridgeCall[] = [];
  let overlayWindowState: FakeOverlayWindowState | null = null;
  let cueSequence = 0;
  let dispatchSequence = 0;
  let eventSequence = 0;
  let runtimeEventSequence = 0;

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
    emitEvent('audio://snapshot', structuredClone(audio));
  }

  function pushRuntimeSnapshot() {
    emitEvent('runtime://snapshot', structuredClone(runtime));
    runtimeEventSequence += 1;
    emitEvent('runtime-v2://snapshot', {
      topic: 'snapshot',
      sequence: runtimeEventSequence,
      timestampMs: Date.now(),
      payload: structuredClone(runtime),
    });
  }

  function pushNotification(notification: RuntimeNotification) {
    runtime.notifications = [notification, ...runtime.notifications];
    emitEvent('runtime://notification', structuredClone(notification));
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
    pendingActionRejections.set(action, {
      code: error.code ?? 'runtime.operation-failed',
      message: error.message,
      retriable: error.retriable ?? false,
      details: error.details ?? { rawError: error.message },
    });
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
  function startSpeech(config: AppConfigDraft | undefined) {
    const enabled = config?.speech?.enabled ?? true;
    audio.speech.status = 'ready';
    audio.speech.dispatchState = enabled ? 'waiting-subtitle' : 'idle';
    audio.speech.outputTarget = config?.speech?.outputTarget ?? audio.speech.outputTarget;
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
      const outputTarget = audio.speech.outputTarget;
      if (outputTarget === 'speaker' || outputTarget === 'both') {
        audio.speech.speakerFramesWritten += SPEECH_FRAMES_PER_DISPATCH;
      }
      if (outputTarget === 'virtual-mic' || outputTarget === 'both') {
        audio.speech.virtualMicFramesWritten += SPEECH_FRAMES_PER_DISPATCH;
      }
      pushAudioSnapshot();

      audio.speech.dispatchState = 'waiting-subtitle';
      audio.speech.currentCueId = null;
      audio.speech.currentRequestId = null;
      audio.speech.lastCompletedAt = new Date().toISOString();
      speechEvent('speech.completed', 'cue playback completed', cueId, requestId);
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
    runtime.bridge = {
      ...runtime.bridge,
      processStatus: 'running',
      bridgeState: 'running',
      lifecycleState: 'ready',
      driverHealth: 'running',
      installPhase: 'ready',
      lastErrorCode: null,
      sessionId: 'fake-bridge-session',
      lastHandshakeAt: new Date().toISOString(),
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

  function handleConfigurationAction(action: string | null) {
    switch (action) {
      case 'runtimeSnapshot':
      case 'bootstrapRuntime':
        return envelope(structuredClone(runtime));
      case 'save':
        return envelope(structuredClone(runtime.storage));
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

  function handleDiagnosticsAction(action: string | null) {
    switch (action) {
      case 'snapshot':
        return envelope({ recentLogs: structuredClone(diagnosticsLogs) });
      case 'selfCheck':
      case 'overlaySelfCheck':
        return envelope(structuredClone(runtime));
      default:
        throw new Error(`fake bridge: unsupported diagnostics_v2 action ${String(action)}`);
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
        case 'configuration_v2':
          return handleConfigurationAction(action) as T;
        case 'diagnostics_v2':
          return handleDiagnosticsAction(action) as T;
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
    getOverlayWindowState: () => (overlayWindowState ? { ...overlayWindowState } : null),
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
  };
}

export type FakeBridge = ReturnType<typeof createFakeBridge>;
