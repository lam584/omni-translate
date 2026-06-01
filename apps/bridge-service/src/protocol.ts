export type DriverBridgeProtocolVersion = '2026-06-01';

export type BridgeAudioEncoding = 'pcm16le';

export type BridgeChannelLayout = 'mono' | 'stereo';

export type BridgeLifecycleState = 'idle' | 'initializing' | 'ready' | 'writing' | 'draining' | 'stopped' | 'error';

export type BridgeRuntimeState = 'stopped' | 'starting' | 'running' | 'degraded';

export type DriverHealthState = 'not-installed' | 'damaged' | 'version-mismatch' | 'running';

export type DriverRepairAction = 'reinstall-driver' | 'restart-bridge' | 'rollback-driver' | 'open-diagnostics';

export type DriverBridgeErrorCode =
  | 'driver.not-installed'
  | 'driver.version-mismatch'
  | 'driver.write-failed'
  | 'bridge.not-ready'
  | 'bridge.queue-overflow'
  | 'bridge.permission-denied'
  | 'bridge.timeout'
  | 'installer.rollback-triggered';

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
  virtualRenderDeviceId?: string;
  physicalPlaybackDeviceId?: string;
  mixControl?: BridgeMixControl;
  monitorPlaybackEnabled?: boolean;
  expectedDriverVersion: string;
  expectedBridgeVersion: string;
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

export type DriverInstallState = {
  protocolVersion: DriverBridgeProtocolVersion;
  installChannel: 'development' | 'release';
  driverVersion: string;
  bridgeVersion: string;
  driverHealth: DriverHealthState;
  installedAt: string;
  targetDeviceId: string;
  virtualRenderDeviceId?: string;
  driverBackend?: string;
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
