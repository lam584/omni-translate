export type DriverBridgeProtocolVersion = '2026-06-02';

export type BridgeAudioEncoding = 'pcm16le';

export type BridgeChannelLayout = 'mono' | 'stereo';

export type BridgeLifecycleState = 'idle' | 'initializing' | 'ready' | 'writing' | 'draining' | 'stopped' | 'error';

export type BridgeRuntimeState = 'stopped' | 'starting' | 'running' | 'degraded';

export type DriverHealthState = 'not-installed' | 'damaged' | 'version-mismatch' | 'running';

export type DriverRepairAction = 'reinstall-driver' | 'restart-bridge' | 'rollback-driver' | 'open-diagnostics';

export type BridgeAudioFrame = {
  frameId: string;
  streamId: string;
  encoding: BridgeAudioEncoding;
  channelLayout: BridgeChannelLayout;
  sampleRateHz: 16000 | 24000 | 48000;
  channelCount: 1 | 2;
  frameCount: number;
  timestampMs: number;
  payloadRef: string;
};

export type BridgeInitRequest = {
  type: 'bridge.init';
  requestId: string;
  protocolVersion: DriverBridgeProtocolVersion;
  sessionId: string;
  installChannel: 'development' | 'release';
  targetDeviceId: string;
  virtualRenderDeviceId: string;
  physicalPlaybackDeviceId: string;
  mixControl: BridgeMixControl;
  monitorPlaybackEnabled: boolean;
  expectedDriverVersion: string;
  expectedBridgeVersion: string;
};

export type BridgeInlinePcmFrameHeader = {
  type: 'bridge.source.frame' | 'bridge.translation.frame';
  requestId: string;
  sessionId: string;
  frameId: string;
  streamId: string;
  sampleRateHz: 16000 | 24000 | 48000;
  channelCount: 1 | 2;
  frameCount: number;
  timestampMs: number;
  payloadBytes: number;
};

export type BridgeTranslationFrameAck = {
  type: 'bridge.source.ack' | 'bridge.translation.ack';
  requestId: string;
  frameId: string;
  acceptedFrames: number;
  playbackFramesWritten: number;
};

export type BridgeMixControl = {
  keepOriginalAudio: boolean;
  translatedAudioEnabled: boolean;
  translatedAudioGainDb: number;
  originalAudioGainDb: number;
  duckingEnabled: boolean;
  duckingDepthPercent: number;
  monitorMode: string;
};

export type BridgeInitResponse = {
  type: 'bridge.init.ack';
  requestId: string;
  protocolVersion: DriverBridgeProtocolVersion;
  bridgeState: BridgeRuntimeState;
  driverHealth: DriverHealthState;
  activeDriverVersion?: string;
};

export type BridgeWriteFrameRequest = {
  type: 'bridge.frame.write';
  requestId: string;
  sessionId: string;
  frame: BridgeAudioFrame;
};

export type BridgeWriteFrameAck = {
  type: 'bridge.frame.ack';
  requestId: string;
  frameId: string;
  acceptedAt: string;
  queueDepth: number;
};

export type BridgeStateQuery = {
  type: 'bridge.state.query';
  requestId: string;
};

export type BridgeStateSnapshot = {
  type: 'bridge.state.snapshot';
  requestId: string;
  protocolVersion: DriverBridgeProtocolVersion;
  bridgeState: BridgeRuntimeState;
  lifecycleState: BridgeLifecycleState;
  driverHealth: DriverHealthState;
  driverVersion?: string;
  bridgeVersion: string;
  queuedFrames: number;
  sourceFramesCaptured: number;
  translatedFramesAccepted: number;
  playbackFramesWritten: number;
  underrunCount: number;
  droppedFrameCount: number;
  driverBufferedBytes: number;
  driverMaxBufferedBytes: number;
  driverDroppedBytes: number;
  sourcePendingBytes: number;
  sourcePacerQueuedFrames: number;
  monitorSourceQueuedFrames: number;
  staleSourceFramesDropped: number;
  monitorPlaybackState: string;
  lastFrameTimestampMs?: number;
  lastErrorCode?: DriverBridgeErrorCode;
};

export type BridgeShutdownRequest = {
  type: 'bridge.shutdown';
  requestId: string;
  sessionId: string;
  reason: 'session-ended' | 'installer-rollback' | 'manual-stop';
};

export type DriverBridgeErrorCode =
  | 'driver.not-installed'
  | 'driver.version-mismatch'
  | 'driver.write-failed'
  | 'driver.testsigning-disabled'
  | 'driver.secure-boot-enabled'
  | 'driver.duplicate-root-devices'
  | 'driver.endpoint-missing'
  | 'driver.ioctl-unavailable'
  | 'driver.abi-mismatch'
  | 'driver.elevation-cancelled'
  | 'driver.probe-failed'
  | 'driver.operation-failed'
  | 'bridge.not-ready'
  | 'bridge.queue-overflow'
  | 'bridge.permission-denied'
  | 'bridge.timeout'
  | 'bridge.session-mismatch'
  | 'bridge.singleton-already-running'
  | 'installer.rollback-triggered';

export type DriverBridgeErrorEvent = {
  type: 'bridge.error';
  requestId?: string;
  code: DriverBridgeErrorCode;
  message: string;
  retriable: boolean;
  bridgeState: BridgeRuntimeState;
  driverHealth: DriverHealthState;
  suggestedAction?: DriverRepairAction;
};

export type DriverBridgeCommand = BridgeInitRequest | BridgeWriteFrameRequest | BridgeStateQuery | BridgeShutdownRequest;

export type DriverBridgeEvent =
  | BridgeInitResponse
  | BridgeWriteFrameAck
  | BridgeStateSnapshot
  | DriverBridgeErrorEvent;
