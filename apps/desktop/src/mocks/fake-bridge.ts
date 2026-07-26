import { audioRuntimeSnapshotMock } from './audio-runtime';
import { runtimeSnapshotMock } from './runtime-shell';
import type { AudioRuntimeSnapshot, SubtitleCueRuntime } from '../schema/audio-runtime';
import type { AppConfigDraft } from '../schema/config';
import type { RuntimeSnapshot } from '../schema/runtime-core';

/**
 * Injectable contract double for the desktop-runtime ↔ bridge boundary.
 *
 * The fake bridge implements the same invoke-level command contract as the
 * Rust bridge service (`session_v2` / `bridge_v2` / direct commands) with an
 * in-memory state machine and a fake translation provider, so integration
 * tests can drive the real renderer runtime modules without real credentials
 * or physical audio devices.
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

type ServiceEnvelope<T> = { data: T; warnings: never[] };

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
  // Deterministic baseline: no cues and zeroed dispatch counters so tests can
  // assert that captured cues and TTS counters really advance via the contract.
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
    recentEvents: [],
  };
  audio.status = 'ready';

  const runtime: RuntimeSnapshot = structuredClone(runtimeSnapshotMock);
  runtime.bridgeStatus = 'tauri-shell';

  const calls: FakeBridgeCall[] = [];
  let overlayWindowState: FakeOverlayWindowState | null = null;
  let cueSequence = 0;
  let dispatchSequence = 0;

  function record(command: string, args: Record<string, unknown> | undefined) {
    calls.push({ command, action: extractAction(args), args });
  }

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

  function startRoute(direction: 'inbound' | 'outbound') {
    const route = direction === 'inbound' ? audio.inbound : audio.outbound;
    route.captureState = 'capturing';
    route.streamBound = true;
    route.framesCaptured += CAPTURE_FRAMES_PER_START;
    route.segmentCount += 1;
    route.lastFrameAt = new Date().toISOString();
    route.lastError = null;
    pushCue(direction, direction === 'inbound' ? 'fake inbound speech' : 'fake outbound speech');
  }

  function stopRoute(direction: 'inbound' | 'outbound') {
    const route = direction === 'inbound' ? audio.inbound : audio.outbound;
    route.captureState = direction === 'inbound' ? 'buffering' : 'armed';
    route.streamBound = false;
  }

  function startSpeech(config: AppConfigDraft | undefined) {
    dispatchSequence += 1;
    const outputTarget = config?.speech?.outputTarget ?? audio.speech.outputTarget;
    audio.speech.status = 'ready';
    audio.speech.dispatchState = 'playing';
    audio.speech.outputTarget = outputTarget;
    audio.speech.currentCueId = audio.subtitleOverlay.activeCue?.cueId ?? null;
    audio.speech.currentRequestId = `fake-tts-${dispatchSequence}`;
    audio.speech.lastStartedAt = new Date().toISOString();
    if (outputTarget === 'speaker' || outputTarget === 'both') {
      audio.speech.speakerFramesWritten += SPEECH_FRAMES_PER_DISPATCH;
    }
    if (outputTarget === 'virtual-mic' || outputTarget === 'both') {
      audio.speech.virtualMicFramesWritten += SPEECH_FRAMES_PER_DISPATCH;
    }
    audio.speech.recentEvents = [
      {
        eventId: `fake-tts-requested-${dispatchSequence}`,
        kind: 'speech.tts-requested',
        summary: `fake bridge dispatched speech to ${outputTarget}`,
        emittedAt: new Date().toISOString(),
        cueId: audio.speech.currentCueId,
        requestId: audio.speech.currentRequestId,
      },
      ...audio.speech.recentEvents,
    ];
  }

  function stopSpeech() {
    audio.speech.dispatchState = 'idle';
    audio.speech.currentCueId = null;
    audio.speech.currentRequestId = null;
    audio.speech.lastCompletedAt = new Date().toISOString();
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

  function handleSessionAction(action: string | null, args: Record<string, unknown> | undefined) {
    const command = (args?.command ?? {}) as Record<string, unknown>;
    switch (action) {
      case 'startRoute':
        startRoute(command.direction as 'inbound' | 'outbound');
        break;
      case 'stopRoute':
        stopRoute(command.direction as 'inbound' | 'outbound');
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

  async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    record(command, args);
    switch (command) {
      case 'session_v2':
        return handleSessionAction(extractAction(args), args) as T;
      case 'bridge_v2':
        return handleBridgeAction(extractAction(args), args) as T;
      case 'configuration_v2':
        return handleConfigurationAction(extractAction(args)) as T;
      case 'start_audio_route':
        startRoute(args?.direction as 'inbound' | 'outbound');
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
  }

  return {
    invoke,
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
  };
}

export type FakeBridge = ReturnType<typeof createFakeBridge>;
