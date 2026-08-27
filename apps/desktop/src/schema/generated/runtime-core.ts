// GENERATED FILE - do not edit by hand.
// Source of truth: apps/desktop/src-tauri/src/{shared,runtime,storage,bridge}/contracts.rs
// Regenerate: OMNI_UPDATE_CONTRACTS=1 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml contract_export

import type { CaptureBackend, MixControl, ProcessLoopbackStatus, SourceCaptureMode } from './driver-bridge-contract';

export type RuntimeNotification = { id: string, level: 'info' | 'warning' | 'error', source: string, message: string, emittedAt: string, };

export type StorageRuntimeSnapshot = { status: 'preview' | 'ready', schemaVersion: number, databasePath: string, credentialBackend: string, hasPersistedConfig: boolean, snapshotCount: number, lastSavedAt: string | null, lastExportPath: string | null, lastImportPath: string | null, };

export type ConfigExportArtifact = { filePath: string, outputPath: string, fileCount: number, exportedAt: string, configContractVersion: number, snapshotCount: number, };

export type ConfigSnapshotRecord = { snapshotId: string, reason: string, createdAt: string, };

export type BenchmarkHistoryRecord = { recordId: string, runId: string, createdAt: string, updatedAt: string, model: string, runStatus: 'running' | 'completed' | 'failed' | 'interrupted', scoreStatus: 'pending' | 'judging' | 'final' | 'evidence-insufficient' | 'judge-failed' | 'benchmark-failed', scoreVersion: 'benchmark-score/v1' | 'benchmark-score/v2' | null, totalScore: number | null, grade: string | null, report: unknown | null, score: unknown | null, error: string | null, };

export type BenchmarkHistorySummary = { recordId: string, runId: string, createdAt: string, updatedAt: string, model: string, runStatus: 'running' | 'completed' | 'failed' | 'interrupted', scoreStatus: 'pending' | 'judging' | 'final' | 'evidence-insufficient' | 'judge-failed' | 'benchmark-failed', scoreVersion: 'benchmark-score/v1' | 'benchmark-score/v2' | null, totalScore: number | null, grade: string | null, error: string | null, };

export type BenchmarkHistoryPage = { records: Array<BenchmarkHistorySummary>, page: number, pageSize: number, totalCount: number, };

export type BenchmarkHistoryDeleteResult = { deleted: boolean, };

export type BenchmarkHistoryClearResult = { deletedCount: number, };

export type RuntimeWindowSnapshot = { label: string, title: string, kind: 'main' | 'subtitle-overlay', visible: boolean, focused: boolean, };

export type BridgeRuntimeSnapshot = {
/**
 * Authoritative native producer identity. These values are absent only
 * before the Bridge has completed its first handshake.
 */
bridgeProcessId: number | null, bridgeInstanceId: string | null, processStatus: 'stopped' | 'starting' | 'running' | 'error', installChannel: 'development' | 'release', installPhase: 'idle' | 'planned' | 'probing' | 'elevation-required' | 'waiting-for-elevation' | 'waiting-for-restart' | 'installing-driver' | 'uninstalling-driver' | 'starting-bridge' | 'verifying' | 'rollback-required' | 'ready', targetDeviceId: string, virtualRenderDeviceId: string, physicalPlaybackDeviceId: string, physicalPlaybackLevel: number, mixControl: MixControl, monitorPlaybackEnabled: boolean, translationPlaybackEnabled: boolean, virtualMicOutputRequested: boolean, expectedDriverVersion: string, expectedBridgeVersion: string, bridgeState: 'stopped' | 'starting' | 'running' | 'degraded', lifecycleState: 'idle' | 'initializing' | 'ready' | 'writing' | 'draining' | 'stopped' | 'error', driverHealth: 'not-installed' | 'damaged' | 'version-mismatch' | 'running', driverVersion: string | null, bridgeVersion: string, sourceCaptureMode: SourceCaptureMode, captureBackend: CaptureBackend, processLoopbackSupported: boolean, processLoopbackStatus: ProcessLoopbackStatus, windowsBuildNumber: number | null, processLoopbackMinimumWindowsBuild: number, excludedProcessId: number | null, processLoopbackFailureDetail: string | null, captureLifecycleState: string, captureRestartCount: number, capturePacketCount: number, captureFramesReceived: number, capturePeak: number, captureRms: number, captureSilentPacketCount: number, captureInvalidSampleCount: number, resolvedPhysicalPlaybackDeviceId: string, physicalPlaybackStatus: 'uninitialized' | 'rebinding' | 'ready' | 'failed', playbackOwnerGeneration: number, monitorBufferedMs: number, monitorUnderrunCount: number, monitorOverrunCount: number, queuedFrames: number, sourceFramesCaptured: number, translatedFramesAccepted: number, translationQueueEndTimestampMs: number, playbackFramesWritten: number, underrunCount: number, droppedFrameCount: number, driverBufferedBytes: number, driverMaxBufferedBytes: number, driverCapturedBytes: number, driverDeliveredBytes: number, driverDroppedBytes: number, sourcePendingBytes: number, sourcePacerQueuedFrames: number, monitorSourceQueuedFrames: number, staleSourceFramesDropped: number, sourceSubscriberActive: boolean, sourceGeneration: number, sourceGenerationToken: string | null, sourceWorkerPhase: string, sourceWorkerLastProgressTimestampMs: number | null, sourceReadCalls: number, sourceZeroByteReads: number, sourceMonitorPlaybackEnabled: boolean, monitorPlaybackState: string, lastFrameTimestampMs: number | null, lastErrorCode: ('driver.not-installed' | 'driver.version-mismatch' | 'driver.write-failed' | 'driver.testsigning-disabled' | 'driver.secure-boot-enabled' | 'driver.memory-integrity-enabled' | 'driver.reboot-required' | 'driver.audio-probe-failed' | 'driver.duplicate-root-devices' | 'driver.endpoint-missing' | 'driver.ioctl-unavailable' | 'driver.abi-mismatch' | 'driver.elevation-cancelled' | 'driver.probe-failed' | 'driver.operation-failed' | 'bridge.not-ready' | 'bridge.queue-overflow' | 'bridge.permission-denied' | 'bridge.timeout' | 'bridge.session-mismatch' | 'bridge.singleton-already-running' | 'bridge.process-loopback-unsupported' | 'bridge.process-loopback-activation-failed' | 'bridge.process-loopback-capture-failed' | 'bridge.playback-ownership-barrier-failed' | 'bridge.physical-playback-rebind-failed' | 'bridge.translation-generation-ended' | 'bridge.translation-output-bypass' | 'bridge.translation-playback-failed' | 'bridge.virtual-mic-output-unavailable' | 'bridge.virtual-mic-driver-unavailable' | 'bridge.virtual-mic-format-unsupported' | 'bridge.virtual-mic-session-failed' | 'bridge.virtual-mic-write-failed' | 'monitor.virtual-playback-loop' | 'installer.rollback-triggered') | null, recommendedAction: ('reinstall-driver' | 'restart-bridge' | 'rollback-driver' | 'open-diagnostics') | null, pipeName: string, pipePath: string, audioPipePath: string, sourcePipePath: string, runtimeRoot: string, sessionId: string | null, lastHandshakeAt: string | null, rollbackSupported: boolean, status: 'draft' | 'ready' | 'warning' | 'unsupported' | 'unknown', driverProbeState: 'idle' | 'probing' | 'ready' | 'failed', testSigningEnabled: boolean, signatureEnforcementBypassed: boolean, memoryIntegrityEnabled: boolean, secureBootEnabled: boolean | null, secureBootProbeStatus: 'idle' | 'waiting-for-elevation' | 'detected' | 'cancelled' | 'unavailable', rootDeviceCount: number, rootInstanceIds: Array<string>, endpointName: string | null, captureEndpointName: string | null, virtualMicOutputSupported: boolean, virtualMicOutputStatus: 'unknown' | 'probing' | 'ready' | 'unsupported' | 'failed', virtualMicFormat: string | null, virtualMicFramesWritten: number, virtualMicWriteFailures: number, virtualMicLastGeneration: number, virtualMicBufferedBytes: number, virtualMicMaxBufferedBytes: number, virtualMicConsumedBytes: number, virtualMicDroppedBytes: number, virtualMicUnderrunBytes: number, virtualMicRejectedWrites: number, virtualMicSessionActive: boolean, abiVersion: string | null, ioctlAvailable: boolean, lastDriverOperation: DriverOperationResult | null, driverDetail: string | null, };

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
