import type { ConfigStatus, DiagnosticsExportScope, DiagnosticsSupportTier, DriverInstallChannel, DriverInstallPhase } from './config';
import type {
  BridgeLifecycleState,
  BridgeMixControl,
  BridgeRuntimeState,
  DriverBridgeErrorCode,
  DriverHealthState,
  DriverRepairAction,
} from './driver-bridge-contract';

export type RuntimeCoreState = 'booting' | 'ready' | 'degraded';

export type RuntimeBridgeStatus = 'browser-preview' | 'tauri-shell' | 'runtime-error';

export type BridgeProcessStatus = 'stopped' | 'starting' | 'running' | 'error';

export type RuntimeWindowKind = 'main' | 'subtitle-overlay';

export type RuntimeNotificationLevel = 'info' | 'warning' | 'error';

export type RuntimeNotification = {
  id: string;
  level: RuntimeNotificationLevel;
  source: string;
  message: string;
  emittedAt: string;
};

export type StorageRuntimeSnapshot = {
  status: 'preview' | 'ready';
  schemaVersion: number;
  databasePath: string;
  credentialBackend: string;
  hasPersistedConfig: boolean;
  snapshotCount: number;
  lastSavedAt: string | null;
  lastExportPath: string | null;
  lastImportPath: string | null;
};

export type RuntimeWindowSnapshot = {
  label: string;
  title: string;
  kind: RuntimeWindowKind;
  visible: boolean;
  focused: boolean;
};

export type BridgeRuntimeSnapshot = {
  processStatus: BridgeProcessStatus;
  installChannel: DriverInstallChannel;
  installPhase: DriverInstallPhase;
  targetDeviceId: string;
  virtualRenderDeviceId: string;
  physicalPlaybackDeviceId: string;
  /** Physical playback volume percentage (0-100). */
  physicalPlaybackLevel: number;
  mixControl: BridgeMixControl;
  monitorPlaybackEnabled: boolean;
  expectedDriverVersion: string;
  expectedBridgeVersion: string;
  bridgeState: BridgeRuntimeState;
  lifecycleState: BridgeLifecycleState;
  driverHealth: DriverHealthState;
  driverVersion: string | null;
  bridgeVersion: string;
  captureBackend: string;
  captureLifecycleState: string;
  captureRestartCount: number;
  capturePacketCount: number;
  captureFramesReceived: number;
  capturePeak: number;
  captureRms: number;
  captureSilentPacketCount: number;
  captureInvalidSampleCount: number;
  resolvedPhysicalPlaybackDeviceId: string;
  monitorBufferedMs: number;
  monitorUnderrunCount: number;
  monitorOverrunCount: number;
  queuedFrames: number;
  sourceFramesCaptured: number;
  translatedFramesAccepted: number;
  playbackFramesWritten: number;
  underrunCount: number;
  droppedFrameCount: number;
  driverBufferedBytes: number;
  driverMaxBufferedBytes: number;
  driverCapturedBytes: number;
  driverDeliveredBytes: number;
  driverDroppedBytes: number;
  sourcePendingBytes: number;
  sourcePacerQueuedFrames: number;
  monitorSourceQueuedFrames: number;
  staleSourceFramesDropped: number;
  sourceSubscriberActive: boolean;
  sourceGeneration: number;
  sourceWorkerPhase: string;
  sourceWorkerLastProgressTimestampMs: number | null;
  sourceReadCalls: number;
  sourceZeroByteReads: number;
  monitorPlaybackState: string;
  lastFrameTimestampMs: number | null;
  lastErrorCode: DriverBridgeErrorCode | null;
  recommendedAction: DriverRepairAction | null;
  pipeName: string;
  pipePath: string;
  audioPipePath: string;
  sourcePipePath: string;
  runtimeRoot: string;
  sessionId: string | null;
  lastHandshakeAt: string | null;
  rollbackSupported: boolean;
  status: 'draft' | 'ready' | 'warning' | 'unsupported' | 'unknown';
  driverProbeState: 'idle' | 'probing' | 'ready' | 'failed';
  testSigningEnabled: boolean;
  signatureEnforcementBypassed: boolean;
  memoryIntegrityEnabled: boolean;
  secureBootEnabled: boolean | null;
  secureBootProbeStatus: 'idle' | 'waiting-for-elevation' | 'detected' | 'cancelled' | 'unavailable';
  rootDeviceCount: number;
  rootInstanceIds: string[];
  endpointName: string | null;
  abiVersion: string | null;
  ioctlAvailable: boolean;
  lastDriverOperation: DriverOperationResult | null;
  driverDetail: string | null;
};

export type DriverOperationResult = {
  schemaVersion: number;
  operationId: string;
  action: string;
  succeeded: boolean;
  phase: string;
  errorCode: string | null;
  summary: string;
  logPath: string;
  startedAt: string;
  finishedAt: string;
};

export type DiagnosticLogEntryRuntime = {
  id: string;
  category: string;
  level: RuntimeNotificationLevel;
  summary: string;
  detail: string | null;
  emittedAt: string;
  /** Originating subsystem; always emitted by the backend, absent on frontend-fabricated entries. */
  source?: string | null;
  /** Elapsed milliseconds attached by the backend for timed operations. */
  elapsedMs?: number | null;
};

export type DiagnosticLogCategoryRuntime = {
  category: string;
  filePath: string;
  entryCount: number;
  lastEntryAt: string | null;
};

export type DiagnosticSupportSignalRuntime = {
  id: string;
  label: string;
  status: ConfigStatus;
  summary: string;
  recommendedAction: string | null;
};

export type ModelTraceCallRuntime = {
  traceId: string;
  callId: string;
  name: string;
  status: 'running' | 'succeeded' | 'failed';
  providerId: string;
  model: string;
  routeMode: string | null;
  cueId: string | null;
  startedAt: string;
  completedAt: string | null;
  elapsedMs: number | null;
  lastError: string | null;
};

export type ModelTraceSummaryRuntime = {
  activeTraceId: string | null;
  totalCalls: number;
  succeededCalls: number;
  failedCalls: number;
  lastError: string | null;
  lastCallAt: string | null;
  recentCalls: ModelTraceCallRuntime[];
};

export type DiagnosticsRuntimeSnapshot = {
  status: ConfigStatus | 'preview';
  supportTier: DiagnosticsSupportTier;
  installStatus: ConfigStatus;
  providerStatus: ConfigStatus;
  driverStatus: ConfigStatus;
  deviceStatus: ConfigStatus;
  lastSelfCheckAt: string | null;
  lastExportScope: DiagnosticsExportScope | null;
  lastExportPath: string | null;
  lastExportedAt: string | null;
  categories: DiagnosticLogCategoryRuntime[];
  supportMatrix: DiagnosticSupportSignalRuntime[];
  modelTraceSummary: ModelTraceSummaryRuntime;
  recentLogs: DiagnosticLogEntryRuntime[];
  recentErrors: DiagnosticLogEntryRuntime[];
  /** Lines discarded because the bounded backend log channel was full. */
  logDroppedCount?: number;
  /** Failed writes observed by the backend log writer thread. */
  logWriteErrorCount?: number;
};

export type DiagnosticsExportArtifact = {
  scope: DiagnosticsExportScope;
  outputPath: string;
  generatedAt: string;
  fileCount: number;
};

export type RuntimeSnapshot = {
  coreState: RuntimeCoreState;
  bridgeStatus: RuntimeBridgeStatus;
  activeProfileId: string;
  trayReady: boolean;
  lastSyncAt: string;
  /** Application-run session id (the trailing ` sid=` token in native logs). */
  sessionId?: string;
  bridge: BridgeRuntimeSnapshot;
  diagnostics: DiagnosticsRuntimeSnapshot;
  storage: StorageRuntimeSnapshot;
  windows: RuntimeWindowSnapshot[];
  notifications: RuntimeNotification[];
};

export const RUNTIME_SNAPSHOT_EVENT = 'runtime://snapshot';
export const RUNTIME_NOTIFICATION_EVENT = 'runtime://notification';
