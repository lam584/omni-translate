// GENERATED FILE - do not edit by hand.
// Source of truth: apps/desktop/src-tauri/src/{shared,runtime,storage,bridge}/contracts.rs
// Regenerate: OMNI_UPDATE_CONTRACTS=1 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml contract_export

import type { MixControl } from './driver-bridge-contract';

export type RuntimeNotification = { id: string, level: 'info' | 'warning' | 'error', source: string, message: string, emittedAt: string, };

export type StorageRuntimeSnapshot = { status: 'preview' | 'ready', schemaVersion: number, databasePath: string, credentialBackend: string, hasPersistedConfig: boolean, snapshotCount: number, lastSavedAt: string | null, lastExportPath: string | null, lastImportPath: string | null, };

export type ConfigExportArtifact = { filePath: string, exportedAt: string, configContractVersion: number, snapshotCount: number, };

export type ConfigSnapshotRecord = { snapshotId: string, reason: string, createdAt: string, };

export type RuntimeWindowSnapshot = { label: string, title: string, kind: 'main' | 'subtitle-overlay', visible: boolean, focused: boolean, };

export type BridgeRuntimeSnapshot = { processStatus: 'stopped' | 'starting' | 'running' | 'error', installChannel: 'development' | 'release', installPhase: 'idle' | 'planned' | 'probing' | 'elevation-required' | 'waiting-for-elevation' | 'waiting-for-restart' | 'installing-driver' | 'uninstalling-driver' | 'starting-bridge' | 'verifying' | 'rollback-required' | 'ready', targetDeviceId: string, virtualRenderDeviceId: string, physicalPlaybackDeviceId: string, physicalPlaybackLevel: number, mixControl: MixControl, monitorPlaybackEnabled: boolean, expectedDriverVersion: string, expectedBridgeVersion: string, bridgeState: 'stopped' | 'starting' | 'running' | 'degraded', lifecycleState: 'idle' | 'initializing' | 'ready' | 'writing' | 'draining' | 'stopped' | 'error', driverHealth: 'not-installed' | 'damaged' | 'version-mismatch' | 'running', driverVersion: string | null, bridgeVersion: string, captureBackend: string, captureLifecycleState: string, captureRestartCount: number, capturePacketCount: number, captureFramesReceived: number, capturePeak: number, captureRms: number, captureSilentPacketCount: number, captureInvalidSampleCount: number, resolvedPhysicalPlaybackDeviceId: string, monitorBufferedMs: number, monitorUnderrunCount: number, monitorOverrunCount: number, queuedFrames: number, sourceFramesCaptured: number, translatedFramesAccepted: number, playbackFramesWritten: number, underrunCount: number, droppedFrameCount: number, driverBufferedBytes: number, driverMaxBufferedBytes: number, driverCapturedBytes: number, driverDeliveredBytes: number, driverDroppedBytes: number, sourcePendingBytes: number, sourcePacerQueuedFrames: number, monitorSourceQueuedFrames: number, staleSourceFramesDropped: number, sourceSubscriberActive: boolean, sourceGeneration: number, sourceWorkerPhase: string, sourceWorkerLastProgressTimestampMs: number | null, sourceReadCalls: number, sourceZeroByteReads: number, monitorPlaybackState: string, lastFrameTimestampMs: number | null, lastErrorCode: ('driver.not-installed' | 'driver.version-mismatch' | 'driver.write-failed' | 'driver.testsigning-disabled' | 'driver.secure-boot-enabled' | 'driver.memory-integrity-enabled' | 'driver.reboot-required' | 'driver.audio-probe-failed' | 'driver.duplicate-root-devices' | 'driver.endpoint-missing' | 'driver.ioctl-unavailable' | 'driver.abi-mismatch' | 'driver.elevation-cancelled' | 'driver.probe-failed' | 'driver.operation-failed' | 'bridge.not-ready' | 'bridge.queue-overflow' | 'bridge.permission-denied' | 'bridge.timeout' | 'bridge.session-mismatch' | 'bridge.singleton-already-running' | 'monitor.virtual-playback-loop' | 'installer.rollback-triggered') | null, recommendedAction: ('reinstall-driver' | 'restart-bridge' | 'rollback-driver' | 'open-diagnostics') | null, pipeName: string, pipePath: string, audioPipePath: string, sourcePipePath: string, runtimeRoot: string, sessionId: string | null, lastHandshakeAt: string | null, rollbackSupported: boolean, status: 'draft' | 'ready' | 'warning' | 'unsupported' | 'unknown', driverProbeState: 'idle' | 'probing' | 'ready' | 'failed', testSigningEnabled: boolean, signatureEnforcementBypassed: boolean, memoryIntegrityEnabled: boolean, secureBootEnabled: boolean | null, secureBootProbeStatus: 'idle' | 'waiting-for-elevation' | 'detected' | 'cancelled' | 'unavailable', rootDeviceCount: number, rootInstanceIds: Array<string>, endpointName: string | null, abiVersion: string | null, ioctlAvailable: boolean, lastDriverOperation: DriverOperationResult | null, driverDetail: string | null, };

export type DriverOperationResult = { schemaVersion: number, operationId: string, action: string, succeeded: boolean, phase: string, errorCode: string | null, summary: string, logPath: string, startedAt: string, finishedAt: string, };

export type DiagnosticLogEntryRuntime = { id: string, category: string, level: 'info' | 'warning' | 'error', summary: string, detail: string | null, emittedAt: string, source: string | null, elapsedMs: number | null, };

export type DiagnosticLogCategoryRuntime = { category: string, filePath: string, entryCount: number, lastEntryAt: string | null, };

export type DiagnosticSupportSignalRuntime = { id: string, label: string, status: 'draft' | 'ready' | 'warning' | 'unsupported' | 'unknown', summary: string, recommendedAction: string | null, };

export type ModelTraceCallRuntime = { traceId: string, callId: string, name: string, status: 'running' | 'succeeded' | 'failed', providerId: string, model: string, routeMode: string | null, cueId: string | null, startedAt: string, completedAt: string | null, elapsedMs: number | null, lastError: string | null, };

export type ModelTraceSummaryRuntime = { activeTraceId: string | null, totalCalls: number, succeededCalls: number, failedCalls: number, lastError: string | null, lastCallAt: string | null, recentCalls: Array<ModelTraceCallRuntime>, };

export type DiagnosticsRuntimeSnapshot = { status: ('draft' | 'ready' | 'warning' | 'unsupported' | 'unknown') | 'preview', supportTier: 'stable' | 'experimental', installStatus: 'draft' | 'ready' | 'warning' | 'unsupported' | 'unknown', providerStatus: 'draft' | 'ready' | 'warning' | 'unsupported' | 'unknown', driverStatus: 'draft' | 'ready' | 'warning' | 'unsupported' | 'unknown', deviceStatus: 'draft' | 'ready' | 'warning' | 'unsupported' | 'unknown', lastSelfCheckAt: string | null, lastExportScope: ('summary' | 'quick' | 'full') | null, lastExportPath: string | null, lastExportedAt: string | null, categories: Array<DiagnosticLogCategoryRuntime>, supportMatrix: Array<DiagnosticSupportSignalRuntime>, modelTraceSummary: ModelTraceSummaryRuntime, recentLogs: Array<DiagnosticLogEntryRuntime>, recentErrors: Array<DiagnosticLogEntryRuntime>, 
/**
 * Lines discarded because the bounded log channel was full.
 */
logDroppedCount: number, 
/**
 * Failed writes observed by the log writer thread.
 */
logWriteErrorCount: number, };

export type DiagnosticsExportArtifact = { scope: 'summary' | 'quick' | 'full', outputPath: string, generatedAt: string, fileCount: number, };

export type RuntimeSnapshot = { coreState: 'booting' | 'ready' | 'degraded', bridgeStatus: 'browser-preview' | 'tauri-shell' | 'runtime-error', activeProfileId: string, trayReady: boolean, lastSyncAt: string, 
/**
 * Application-run session id (the trailing ` sid=` token in the logs),
 * handed to the renderer so frontend records correlate across processes.
 */
sessionId: string, bridge: BridgeRuntimeSnapshot, diagnostics: DiagnosticsRuntimeSnapshot, storage: StorageRuntimeSnapshot, windows: Array<RuntimeWindowSnapshot>, notifications: Array<RuntimeNotification>, };

