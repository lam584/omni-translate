import type { AudioCaptureState, AudioPreBufferState } from './audio-contract';

export type AudioVadState = 'silence' | 'speech';

/**
 * Structured error codes attached to route snapshots and worker error
 * strings by the Rust session error classifier
 * (`src-tauri/src/audio/omni/session_errors.rs`). Mirrors the
 * `DriverBridgeErrorCode` convention in `driver-bridge-contract.ts`.
 */
export type SessionErrorCode =
  | 'session.credential-invalid'
  | 'session.quota-exceeded'
  | 'session.voice-unsupported'
  | 'session.network-unreachable'
  | 'session.provider-internal'
  | 'audio.device-lost'
  | 'audio.flow-stalled';

export type AudioDeviceRuntime = {
  deviceId: string;
  label: string;
  interfaceName: string;
  direction: 'render' | 'capture';
  isDefault: boolean;
  state: string;
};

export type AudioRouteRuntimeSnapshot = {
  routeId: string;
  direction: 'inbound' | 'outbound';
  requestedDeviceId: string;
  effectiveDeviceId: string;
  captureState: AudioCaptureState;
  preBufferState: AudioPreBufferState;
  vadState: AudioVadState;
  bufferAheadMs: number;
  framesCaptured: number;
  segmentCount: number;
  streamBound: boolean;
  lastEnergyDb: number;
  lastFrameAt: string | null;
  activeSegmentId: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
  recommendedAction: string | null;
};

export type SubtitleCueRuntime = {
  cueId: string;
  routeDirection: 'inbound' | 'outbound';
  sourceText: string;
  displaySourceText?: string;
  displaySegments?: SubtitleDisplaySegmentRuntime[];
  translatedText: string;
  startedAt: string;
  endedAt: string;
  committed: boolean;
};

export type SubtitleDisplaySegmentRuntime = {
  sourceText: string;
  translatedText: string;
  pending: boolean;
};

export type SubtitleOverlayRuntimeSnapshot = {
  queueDepth: number;
  droppedCueCount: number;
  firstTranslationAverageMs: number | null;
  firstTranslationLastMs: number | null;
  firstTranslationSampleCount: number;
  activeCue: SubtitleCueRuntime | null;
  recentCues: SubtitleCueRuntime[];
};

export type SpeechDispatchEventRuntime = {
  eventId: string;
  kind: string;
  summary: string;
  emittedAt: string;
  cueId: string | null;
  requestId: string | null;
};

export type SpeechRuntimeSnapshot = {
  status: 'preview' | 'ready' | 'degraded';
  dispatchState: 'idle' | 'waiting-subtitle' | 'queued' | 'deferred' | 'playing' | 'error';
  queueDepth: number;
  cacheEntries: number;
  policy: 'subtitle-first' | 'balanced' | string;
  outputTarget: 'speaker' | 'virtual-mic' | 'both' | string;
  currentCueId: string | null;
  currentRequestId: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastError: string | null;
  speakerFramesWritten: number;
  virtualMicFramesWritten: number;
  mixMode: string;
  pttGateOpen: boolean;
  duckingActive: boolean;
  recentEvents: SpeechDispatchEventRuntime[];
};

export type SttConnectionState = 'idle' | 'connected' | 'reconnecting' | 'disconnected';

export type SttConnectionRuntime = {
  state: SttConnectionState;
  reconnectAttempt: number;
  maxReconnectAttempts: number;
  lastDisconnectReason: string | null;
};

export type AudioRuntimeSnapshot = {
  status: 'preview' | 'ready' | 'degraded';
  host: string;
  renderDevices: AudioDeviceRuntime[];
  captureDevices: AudioDeviceRuntime[];
  inbound: AudioRouteRuntimeSnapshot;
  outbound: AudioRouteRuntimeSnapshot;
  subtitleOverlay: SubtitleOverlayRuntimeSnapshot;
  speech: SpeechRuntimeSnapshot;
  sessionStartedAt: string | null;
  sttConnected: boolean;
  sttBufferSize: number;
  sttConnection: SttConnectionRuntime;
};

export const AUDIO_RUNTIME_SNAPSHOT_EVENT = 'audio://snapshot';
