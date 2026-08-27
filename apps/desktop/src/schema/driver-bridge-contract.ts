/**
 * Driver bridge NDJSON contract. The payload shapes are GENERATED from the
 * Rust structs (see ./generated/bridge-ipc.ts, ./generated/driver-bridge-contract.ts
 * and the contract_export cargo test); this module composes them with the
 * `type` discriminants added by the internally-tagged serde enums
 * (DriverBridgeCommand / DriverBridgeEvent in src-tauri/src/bridge/contracts.rs),
 * derives the union aliases the rest of the app imports, and keeps the pinned
 * protocol version literal guarded by scripts/testing/verify-contracts.mjs.
 */
import type {
  BridgeAudioFrame as GeneratedBridgeAudioFrame,
  BridgeInitRequest as GeneratedBridgeInitRequest,
  BridgeInitResponse as GeneratedBridgeInitResponse,
  BridgeProcessLoopbackProbeRequest as GeneratedBridgeProcessLoopbackProbeRequest,
  BridgeProcessLoopbackProbeResponse as GeneratedBridgeProcessLoopbackProbeResponse,
  BridgeShutdownRequest as GeneratedBridgeShutdownRequest,
  BridgeStateQuery as GeneratedBridgeStateQuery,
  BridgeStateResponse as GeneratedBridgeStateResponse,
  BridgeWriteFrameAck as GeneratedBridgeWriteFrameAck,
  BridgeWriteFrameRequest as GeneratedBridgeWriteFrameRequest,
  DriverBridgeErrorEvent as GeneratedDriverBridgeErrorEvent,
} from './generated/bridge-ipc';
import type {
  AudioFrameAck as GeneratedAudioFrameAck,
  AudioFrameHeader as GeneratedAudioFrameHeader,
  MixControl as GeneratedMixControl,
} from './generated/driver-bridge-contract';

export type DriverBridgeProtocolVersion = '2026-08-27-audio-routing-v8';

// Union aliases derived from the generated fields, so the literal members
// have exactly one source of truth (the Rust contract).
export type BridgeAudioEncoding = GeneratedBridgeAudioFrame['encoding'];
export type BridgeChannelLayout = GeneratedBridgeAudioFrame['channelLayout'];
export type BridgeLifecycleState = GeneratedBridgeStateResponse['lifecycleState'];
export type BridgeRuntimeState = GeneratedBridgeStateResponse['bridgeState'];
export type DriverHealthState = GeneratedBridgeStateResponse['driverHealth'];
export type DriverRepairAction = NonNullable<GeneratedDriverBridgeErrorEvent['suggestedAction']>;
export type DriverBridgeErrorCode = GeneratedDriverBridgeErrorEvent['code'];

export type BridgeAudioFrame = GeneratedBridgeAudioFrame;

// The inline-PCM frame protocol trio is GENERATED from the shared Rust crate
// (crates/omni-bridge-protocol) that both the desktop shell and the bridge
// service compile against; the aliases keep the historical Bridge* names.
export type BridgeInlinePcmFrameHeader = GeneratedAudioFrameHeader;
export type BridgeTranslationFrameAck = GeneratedAudioFrameAck;
export type BridgeMixControl = GeneratedMixControl;

export type BridgeInitRequest = { type: 'bridge.init' } & GeneratedBridgeInitRequest;

export type BridgeInitResponse = { type: 'bridge.init.ack' } & GeneratedBridgeInitResponse;

export type BridgeProcessLoopbackProbeRequest = {
  type: 'bridge.process-loopback.probe';
} & GeneratedBridgeProcessLoopbackProbeRequest;

export type BridgeProcessLoopbackProbeResponse = {
  type: 'bridge.process-loopback.probe.ack';
} & GeneratedBridgeProcessLoopbackProbeResponse;

export type BridgeWriteFrameRequest = { type: 'bridge.frame.write' } & GeneratedBridgeWriteFrameRequest;

export type BridgeWriteFrameAck = { type: 'bridge.frame.ack' } & GeneratedBridgeWriteFrameAck;

export type BridgeStateQuery = { type: 'bridge.state.query' } & GeneratedBridgeStateQuery;

export type BridgeStateSnapshot = { type: 'bridge.state.snapshot' } & GeneratedBridgeStateResponse;

export type BridgeShutdownRequest = { type: 'bridge.shutdown' } & GeneratedBridgeShutdownRequest;

export type DriverBridgeErrorEvent = { type: 'bridge.error' } & GeneratedDriverBridgeErrorEvent;

export type DriverBridgeCommand = BridgeInitRequest | BridgeProcessLoopbackProbeRequest | BridgeWriteFrameRequest | BridgeStateQuery | BridgeShutdownRequest;

export type DriverBridgeEvent =
  | BridgeInitResponse
  | BridgeProcessLoopbackProbeResponse
  | BridgeWriteFrameAck
  | BridgeStateSnapshot
  | DriverBridgeErrorEvent;
