/**
 * Audio runtime contract. The type shapes are GENERATED from the Rust
 * contract structs (see ./generated/audio-runtime.ts and the contract_export
 * cargo test); this module re-exports them, derives the union aliases the
 * rest of the app imports, and keeps the pinned event name plus the
 * frontend-only SessionErrorCode classification.
 */
import type { AudioRouteRuntimeSnapshot, SttConnectionRuntime } from './generated/audio-runtime';

export type {
  AudioDeviceRuntime,
  AudioRouteRuntimeSnapshot,
  AudioRuntimeSnapshot,
  OverlayRenderReceiptRuntime,
  SpeechDispatchEventRuntime,
  SpeechRuntimeSnapshot,
  SttConnectionRuntime,
  SubtitleCueRuntime,
  SubtitleDeltaRuntime,
  SubtitleDisplaySegmentRuntime,
  SubtitleOverlayRuntimeSnapshot,
  WatchCueComparisonRuntime,
  WatchIssueRuntime,
  WatchSessionReportRuntime,
  WatchSessionReportSummaryRuntime,
  WatchTimelineEventRuntime,
} from './generated/audio-runtime';

export type AudioVadState = AudioRouteRuntimeSnapshot['vadState'];
export type SttConnectionState = SttConnectionRuntime['state'];

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
  | 'session.model-reference-invalid'
  | 'session.launch-precheck-failed'
  | 'session.launch-stage-failed'
  | 'session.launch-timeout'
  | 'session.network-unreachable'
  | 'session.provider-internal'
  | 'audio.device-lost'
  | 'audio.capture-failed'
  | 'audio.flow-stalled';

export const AUDIO_RUNTIME_SNAPSHOT_EVENT = 'audio://snapshot';
export const SUBTITLE_DELTA_EVENT = 'audio://subtitle-delta';
